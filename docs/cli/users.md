---
summary: "CLI reference for `openclaw users` (profiles, pre-created profiles, email aliases, and duplicate merges)"
read_when:
  - You need to find a durable Gateway profile ID
  - You want to link an email alias or merge duplicate profiles
title: "Users"
---

# `openclaw users`

Manage durable Gateway profiles through the Gateway RPC API. These profiles
identify people; they are separate from the CLI's `--profile` option, which
selects an isolated OpenClaw configuration and state directory.

## Common options

- `--url <url>`: Gateway WebSocket URL; defaults to `gateway.remote.url` when configured.
- `--token <token>`: Gateway token, if required.
- `--timeout <ms>`: RPC timeout in milliseconds; defaults to `10000`.
- `--json`: Print the Gateway result as JSON.

Place these options after the subcommand.

## List profiles

```bash
openclaw users list
openclaw users list --json
```

Requires `operator.read`. Human output lists each profile's ID, display name, and
email aliases. Use the durable IDs when linking or merging profiles.

## Create a profile from an email

```bash
openclaw users create person@example.com
openclaw users create person@example.com --name "Person Name" --json
```

Requires `operator.admin`. Calls `users.create` with `email` and, when `--name`
is given, `displayName`. It creates the profile that the person's first sign-in
with that email would create, so you can set the display name, avatar, or
channel links before they sign in; their later sign-in lands on the same
profile. If the email already belongs to a profile, that profile is returned
unchanged and `--name` is ignored. Human output prints the profile line and
notes when it already existed; JSON returns `profile` and `created`. See
[Creating a profile before first sign-in](/concepts/user-model#creating-a-profile-before-first-sign-in).

## Link an email alias

```bash
openclaw users link-email person@example.com --to <profile-id>
```

Requires `operator.admin`. Calls `users.linkEmail` to move one email alias to the
target profile. If the previous profile loses its last email, it merges into the
target. Otherwise, it remains a separate profile with its other aliases.

## Merge duplicate profiles

```bash
openclaw users merge <source-profile-id> --into <target-profile-id>
openclaw users merge <source-profile-id> --into <target-profile-id> --json
```

Requires `operator.admin`. Calls `users.merge` with `sourceProfileId` and
`targetProfileId`. Use this when both profiles belong to the same person and the
whole source profile should retire, including when it has no email aliases.

The target must be an existing, unmerged profile distinct from the source.
The shared **Owner** profile cannot be merged in either direction. Repeating an
already completed merge into the same target succeeds. If the source points to
another survivor, the command fails and names that current profile.

Human output names the survivor and retired ID. JSON returns `profile`, the
surviving profile, and `movedAliasKinds`, the alias categories actually moved:
`email`, `provider`, or `channel`. An unchanged repeat returns an empty list.

The survivor keeps its role, display name, primary identity, and conflicting
preferences and account choices. Logins, channel links, and personal accounts
follow the survivor under the existing merge rules. History keeps its original
attribution; previously captured authority for the retired profile does not
transfer. See [Merging duplicate profiles](/concepts/user-model#merging-duplicate-profiles)
for transfer rules and personal `USER.md` handling.
