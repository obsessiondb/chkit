# Session Context

## User Prompts

### Prompt 1

<system_instruction>
You are working inside Conductor, a Mac app that lets the user run many coding agents in parallel.
Your work should take place in the /Users/marc/conductor/workspaces/chx/tacoma directory (unless otherwise directed), which has been set up for you to work in.
Each workspace has a .context directory (gitignored) where you can save files to collaborate with other agents.
The target branch for this workspace is marc/num-6439-setup-cd-for-documentation-site. Use this for actions ...

### Prompt 2

the changes might just be in the repository, but not committed (so just dirty file `/Users/marc/Workspace/chx/scripts/manual-release.ts`

2. you need to create a new changeset
3. research best practices with changeset publish vs bun publish. what does changeset publish give me on top? 

also please make a `release.md` file in docs, to document how to do a release.

### Prompt 3

you can delete the @.changeset/fix-workspace-deps.md then commit the changes. Push then, create a PR, wait for the checks to pass and merge it. Let me know when finished.

