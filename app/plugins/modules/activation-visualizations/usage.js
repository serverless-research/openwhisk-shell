/*
 * Copyright 2018 IBM Corporation
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

/** list of related commands */
const all = ['summary', 'timeline', 'grid']
const allExcept = cmd => all.filter(_ => _ !== cmd)

/** optional arguments */
const optional = [{ name: 'action|app', docs: 'include only activity for the given action or composition' },
                  { name: '--success',  docs: 'include only successful activations' },
                  { name: '--failure', docs: 'include only failed activations' },
                  { name: '--outliers [option]', docs: 'include only outlier activations', allowed: ['min',25,50,90,95,99,'max'], defaultValue: 90 },
                  { name: '--batches N', docs: 'the number of 200-activation batches to fetch', allowed: [1, 2, '...', 32 ], defaultValue: 2 }]

/* the breadcrumb chain */
const parents = ['visualize']

const header = {
    summary: 'Visualize the statistical distribution of activation latencies',
    timeline: 'Show activity over time',
    grid: 'Show a large number of recent activations in a grid view'
}

/**
 * Usage model for the editor plugin
 *
 */
module.exports = {
    toplevel: {
        title: 'Activation visualizations',
        header: 'These commands will help you visualize your activations',
        example: 'visualize <command>',
        commandPrefix: '',
        available: [{ command: 'summary', docs: header.summary },
                    { command: 'timeline', docs: header.timeline },
                    { command: 'grid', docs: header.grid }],
        related: ['wsk activation', 'composer session']
    },

    summary: {
        title: 'Summarize performance',
        header: '${header.summary}.',
        example: 'summary [action|app]',
        optional, parents,
        related: allExcept('summary')
    },

    timeline: {
        title: 'Activity timeline',
        header: '${header.timeline}.',
        example: 'timeline [action|app]',
        optional, parents,
        related: allExcept('timeline')
    },

    grid: {
        title: 'Activity grid',
        header: `${header.grid}.`,
        example: 'grid [action|app]',
        detailedExample: { command: 'grid --outliers max --success',
                           docs: 'show only the worst offending successful activations' },
        optional, parents,
        related: allExcept('grid')
    }
}
