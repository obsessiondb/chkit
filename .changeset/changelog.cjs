// @ts-check
const { default: defaultChangelog } = require('@changesets/cli/changelog')

/** @type {typeof defaultChangelog} */
const changelog = {
	getReleaseLine: defaultChangelog.getReleaseLine,
	getDependencyReleaseLine: async (_changesets, dependenciesUpdated) =>
		dependenciesUpdated.length === 0
			? ''
			: `- Updated dependencies: ${dependenciesUpdated.map((dependency) => `\`${dependency.name}@${dependency.newVersion}\``).join(', ')}`,
}

module.exports = changelog
