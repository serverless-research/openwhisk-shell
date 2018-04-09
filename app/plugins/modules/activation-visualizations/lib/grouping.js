/*
 * Copyright 2017 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const { isSuccess, pathOf, latencyBucket, nLatencyBuckets, isUUIDPattern } = require('./util'),
      prettyPrintDuration = require('pretty-ms')

const durationOf = _ => {
    const waitAnno = _.annotations.find(({key}) => key === 'waitTime'),
          initAnno = _.annotations.find(({key}) => key === 'initTime'),
          wait = waitAnno ? waitAnno.value : 0,  // this is "Queueing Time" as presented in the UI
          init = initAnno ? initAnno.value : 0,   // and this is "Container Initialization"
          executionTime = _.end - _.start,
          duration = executionTime + wait  // note: executionTime already factors in `init`, so we don't add it here

    // oof
    _.executionTime = executionTime
    _._duration = duration

    return { duration, executionTime, wait, init }
}

/**
 * Compute statistical properties of a given group of activations
 *
 */
const summarizePerformance = (activations, options) => {
    const latBuckets = Array(nLatencyBuckets).fill(0)
    const summaries = activations.map(_ => {
        const { duration, executionTime, wait, init } = durationOf(_)

        if (isSuccess(_)) {
            const latBucket = latencyBucket(options.full ? duration : executionTime)
            latBuckets[latBucket]++
        }

        return { duration, executionTime, wait, init, activation: _ }
    })
    summaries.sort((a,b) => a.duration - b.duration)

    if (summaries.length === 0) {
        return
    }

    const min = summaries[0].duration,
          max = summaries[summaries.length - 1].duration,
          idx25 = ~~(summaries.length * 0.25),
          idx50 = ~~(summaries.length * 0.50),
          idx75 = ~~(summaries.length * 0.75),
          idx90 = ~~(summaries.length * 0.90),
          idx95 = ~~(summaries.length * 0.95),
          idx99 = ~~(summaries.length * 0.99),
          idxOutlier = ~~(summaries.length * (options.outliers === undefined || options.outliers === true ? 0.95 : options.outliers)),  // where do we want to draw the line for "is an outlier"?
          nFast = idx25 + 1,
          fastest = summaries.slice(0, idx25 + 1),
          waitAvgForFastest = fastest.reduce((total, {wait}) => total + wait, 0) / nFast,
          initAvgForFastest = fastest.reduce((total, {init}) => total + init, 0) / nFast,
          durAvgForFastest = fastest.reduce((total, {executionTime}) => total + executionTime, 0) / nFast,
          totalAvgForFastest = fastest.reduce((total, {duration,wait,init}) => total + duration, 0) / nFast

    /** why was the given activation so slow? */
    const explainOutlier = activation => {
        const waitAnno = activation.annotations.find(({key}) => key === 'waitTime'),
              waitTime = (waitAnno && waitAnno.value) || 0,
              initAnno = activation.annotations.find(({key}) => key === 'initTime'),
              initTime = (initAnno && initAnno.value) || 0,
              start = activation.start - waitTime,
              executionTime = activation.end - activation.start,
              total = executionTime + waitTime /*+ initTime*/
              
        const durDisparity = executionTime - durAvgForFastest,
              waitDisparity = Math.max(0, waitTime - waitAvgForFastest),
              initDisparity = Math.max(0, initTime - initAvgForFastest),
              disparity = total - totalAvgForFastest,
              reasons = [ ]

        if (durDisparity > 0) reasons.push({ why: 'Execution Time', cover: durDisparity / disparity, disparity: durDisparity })
        if (waitDisparity > 0) reasons.push({ why: 'Queueing Delays', cover: waitDisparity / disparity, disparity: waitDisparity })
        if (initDisparity > 0) reasons.push({ why: 'Container Init', cover: initDisparity / disparity, disparity: initDisparity })

        reasons.sort((a,b) => b.cover - a.cover)

        return { total, start, reasons }
    }

    // outlier activations; make sure not to include degenerate
    // "outliers" that are just the median
    const median = summaries[idx50].duration
    const outliers = summaries.slice(idxOutlier).filter(({duration}) => duration > median),
          outlierMax = outliers.reduce((max, {duration}) => Math.max(max, duration), 0)

    return { min, max,
             latBuckets,
             explainOutlier,
             outliers, outlierMax,
             n: {
                 min, max,
                 25: summaries[idx25].duration,
                 50: summaries[idx50].duration,
                 75: summaries[idx75].duration,
                 90: summaries[idx90].duration,
                 95: summaries[idx95].duration,
                 99: summaries[idx99].duration
             }
           }
}
exports.summarizePerformance = summarizePerformance

/**
 * Given a string 'x.y.z', return an array of numbers [x,y,z].
 *
 */
const semver = version => version.split('.').map(Number)

class SemVer {
    constructor(version) {
        this.version = semver(version)
    }

    compare(v2) {
        return this._compare(semver(v2))
    }

    localeCompare(that) {
        return this._compare(that.version)
    }

    _compare(thatVersion) {
        return this.version[0] - thatVersion[0]
            || this.version[1] - thatVersion[1]
            || this.version[2] - thatVersion[2]
    }

    toString() {
        return this.version.join('.')
    }
}

/**
 * Form a grouping key that discriminates by version and path
 * attributes
 *
 */
const splitByVersion = (activation, path) => ({
    version: new SemVer(activation.version),
    groupKey: `${path} v${activation.version}`
})

/**
 * Form a grouping key that discriminates by the path attribute, and
 * a binary discrimination of the version field (< and >=)
*
*/
const splitAroundVersion = version => {
    const split = new SemVer(version)

    return (activation, path) => {
        const version = split.compare(activation.version) > 0 ? 'A' : 'B',
              groupKey = `${path} v${version}`
        return { version, groupKey }
    }
}

/**
  * Compute statData over all activations
  *
  */
const summarizeWhole = (groups, options) => {
    const allActivations = groups.reduce((L, group) => L.concat(group.successes || group.activations), []),
          nSuccesses = groups.reduce((S, group) => S + group.nSuccesses, 0),
          nFailures = groups.reduce((S, group) => S + group.nFailures, 0)

    return {
        statData: summarizePerformance(allActivations, options),
        nFailures,
        nSuccesses,
        errorRate: nFailures / (nSuccesses + nFailures)
    }
}

/**
  * Compute statData over all activations
  *
  */
const summarizeWhole2 = (allActivations, options) => {
    const { nSuccesses, nFailures } = allActivations.reduce((S, activation) => {
        if (isSuccess(activation)) S.nSuccesses++
        else S.nFailures++
        return S
    }, { nSuccesses: 0, nFailures: 0 })

    return {
        statData: summarizePerformance(allActivations, options),
        nFailures,
        nSuccesses,
        errorRate: nFailures / (nSuccesses + nFailures)
    }
}

/**
 * Helper to grouping by action, but assuming that the caller is
 * taking care of providing us with activations.
 *
 */
const addToGroup = (options, totals, splitRequested, splitter) => (groups, activation) => {
    const _path = pathOf(activation)
    const path = options.subgrouping === 'success' ? isSuccess(activation) ? 'success' : 'failure'
          : options.subgrouping === 'duration' ? isSuccess(activation) ? latencyBucket(activation.end - activation.start) : nLatencyBuckets
          : _path,
          {version, groupKey} = !splitRequested ? {groupKey: path} : splitter(activation, path)

    if (options.key && groupKey !== options.key) {
        // we were asked to filter by groupKey
        return groups
    }

    // commenting out the bizarre filter. see shell issue #120
    if (true/*options.all || options.name || (!(_path.match && _path.match(isUUIDPattern)) && !activation.cause)*/) {
        let group = groups[groupKey]
        if (!group) {
            group = groups[groupKey] = { name: activation.name, nSuccesses: 0, nFailures: 0, path, groupKey, version }

            if (options.groupBySuccess) {
                group.successes = []
                group.failures = []
            } else {
                group.activations = []
            }
        }

        // add the activation to the appropriate list
        const success = isSuccess(activation),
              list = !options.groupBySuccess
              ? group.activations               // not grouping by success
              : success ? group.successes       // we are, and the activation was successful
              : group.failures                  // we are, and the activation failed
        list.push(activation)

        if (success) group.nSuccesses++
        else group.nFailures++

        totals.totalCount++
        if (!totals.minTime || activation.start < totals.minTime) totals.minTime = activation.start
        if (!totals.maxTime || activation.start > totals.maxTime) totals.maxTime = activation.start
    }

    return groups
}

/**
 * Turn an "action group" --- activations grouped by action, keyed by
 * the action's path --- into an array. The caller will take care of
 * sorting this array how it sees fit.
 *
 */
const toArray = (map, options) => {
    const groups = [],
          outlierFilter = filterByOutlieriness(options)

    for (let x in map) {
        const group = groups[groups.push(map[x]) - 1]

        group.statData = summarizePerformance(group.successes && group.successes.length > 0
                                              ? group.successes
                                              : group.failures || group.activations, options)
        group.errorRate = group.nFailures / (group.nSuccesses + group.nFailures)

        // the user asked us to filter to show only outliers?
        group.activations = outlierFilter(group)

        if (options.groupBySuccess) {
            group.count = group.successes.length + group.failures.length
        } else {
            group.count = group.activations.length
        }
    }

    return groups
}

/**
 * Cost function for an activation
 *   TODO factor this out!!!!
 */
const costOf = activation => {
    const limitsAnnotation = activation.annotations.find(({key}) => key === 'limits'),
          duration = activation.end - activation.start,
          cost = !limitsAnnotation ? 0 : ((limitsAnnotation.value.memory/1024) * (Math.ceil(duration/100)/10) * 0.000017 * 1000000)

    return ~~(cost * 100)/100
}

/**
 * Construct a success versus failure timeline model
 *
 */
const successFailureTimeline = (activations, { nBuckets=10000, full=false }) => {
    if (activations.length === 0) {
        return []
    }

    // some parameters of the model
    const first = activations[activations.length - 1].start,
          last = activations[0].start,
          interval = ~~((last - first) / nBuckets),
          bucketize = timestamp => Math.min(nBuckets - 1, ~~((timestamp - first) / interval))

    const mkActivations = () => {
        const buckets = Array(nBuckets)
        for (let idx = 0; idx < nBuckets; idx++) {
            buckets[idx] = [] // array of activations
        }
        return buckets
    }

    // now we construct the model
    const buckets = activations.reduce((buckets, activation) => {
        const success = isSuccess(activation),
              tally = success ? buckets.success : buckets.failure,
              idx = bucketize(activation.start)

        tally[idx]++
        buckets.cost[idx] += costOf(activation)
        buckets.activations[idx].push(activation)

        return buckets

    }, { success: Array(nBuckets).fill(0),
         activations: mkActivations(),
         failure: Array(nBuckets).fill(0),
         cost: Array(nBuckets).fill(0),
         interval, first, last, nBuckets    // pass through the parameters to the view, in case it helps
       })

    return buckets
}

/**
 * Group the activations by action, and compute some summary
 * statistics for each group: error rate, count, success versus
 * failure.
 *
 */
exports.groupByAction = (activations, options) => {
    const splitRequested = options.split,
          splitter = splitRequested && (options.split === true ? splitByVersion : splitAroundVersion(options.split))

    const totals = { minTime: undefined, maxTime: undefined, totalCount: 0},
          timeline = successFailureTimeline(activations, options),
          map = activations.reduce(addToGroup(options, totals, splitRequested, splitter), {}),
          groups = toArray(map, options) // turn the map into an array, for easier consumption

    return Object.assign(totals, {
        timeline,
        groups,
        summary: summarizeWhole(groups, options)   // a "statData" object, for all activations
    })
}

/**
 * User asked to filter based on outlier-iness. This must have a
 * grouping. the {activations,statData} is a group from grouping.js
 *
 */
const filterByOutlieriness = options => ({activations,statData}) => {
    if (!options.outliers) {
        return activations
    } else {
        const thresholdN = typeof options.outliers === 'number' ?
              options.outliers < 1 ? 100 * options.outliers : options.outliers  // --outliers 0.25 versus --outliers 25
              : options.outliers === true ? '90' // if true, this means the user passed --outliers with no arg; use default
              : options.outliers                 // some random string; we'll check for supported strings in the next if clause
              threshold = statData.n[thresholdN]

        // check that the user passed a supported options.outliers parameter
        if (typeof options.outliers !== true && threshold === undefined) {
            // then the user specified an undefined threhsold
            throw new Error(`Unsupported threhsold. Supported threhsolds: ${Object.keys(statData.n)}`)
        }

        return activations.filter(activation => {
            const waitAnno = activation.annotations.find(({key}) => key === 'waitTime'),
                  waitTime = (waitAnno && waitAnno.value) || 0,
                  executionTime = activation.end - activation.start,
                  duration = executionTime + waitTime
            return duration >= threshold
        })
    }
}


/**
 * Group the given activations by time
 *
 */
exports.groupByTimeBucket = (activations, options) => {
    // commenting out the bizarre filter. see shell issue #120
    /*if (!options.all) {
        activations = activations.filter(activation => {
            const path = pathOf(activation)
            return !(path.match && path.match(isUUIDPattern)) && !activation.cause
        })
    }*/

    // first, sort the activations by increasing start time, to help
    // with bucketing
    activations.sort((a,b) => a.start - b.start)

    // compute bucket properties
    const nBuckets = options.buckets || 46,
          first = activations[0],
          last = activations[activations.length - 1],
          minTime = first && first.start,
          maxTime = last && last.start,
          timeRangeInMillis = maxTime - minTime + 1,
          bucketWidthInMillis = timeRangeInMillis / nBuckets,
          totals = { minTime: undefined, maxTime: undefined, totalCount: 0},
          grouper = addToGroup(options, totals)

    const buckets = activations.reduce((bucketArray, activation) => {
        const bucketIdx = ~~( (activation.start - minTime) / bucketWidthInMillis)
        grouper(bucketArray[bucketIdx], activation)
        return bucketArray
    }, new Array(nBuckets).fill(0).map(_ => ({}) )) // an array of length nBuckets, of {} -- these will be activation groups, for each timeline bucket


    // the buckets.map turns each timeline bucket, which right now is
    // a map from action path to action, into an array -- for easier
    // consumption
    return Object.assign(totals, {
        bucketWidthInMillis,
        buckets: buckets.map(bucketMap => {
            const bucket = toArray(bucketMap, options)
            return {
                bucket,
                summary: summarizeWhole(bucket, options)
            }
        }),
        summary: summarizeWhole2(activations, options)  // a "statData" object, for all activations
    })
}

