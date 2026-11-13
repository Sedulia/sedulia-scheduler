# Modifications to Postiz

Sedulia Social is a modified version of [Postiz](https://github.com/gitroomhq/postiz-app) (GNU AGPL-3.0, see
`LICENSE`). This file is the notice of modification that section 5(a) of the license asks for: what Sedulia
changed, and when. Postiz itself is the work of its authors; the history before this commit is theirs,
unchanged.

## This tag

- Tag `social-2026-11-13-1085b0f3fd9a`, deployed 2026-11-13.
- Based on upstream Postiz `v2.25.3` (commit `a5affe62c74e39c1e7ac960d50d8418b807d532c`), this commit's parent.
  `git diff a5affe62 <this tag>` shows every change below.
- The deployed image was built with `NEXT_PUBLIC_VERSION=1085b0f3fd9aa11d0634066542cc0db2a6d80607`: the commit in
  Sedulia's private working repository it was built from. That commit's tree is
  `d2014a650fd4806b8c9095de4fdc135aba7c220d`.

## How to check this tag against the deployed build

This tag is that tree plus `BUILDING.md`, this file, and four `if: github.repository == 'gitroomhq/postiz-app'`
lines in two upstream workflow files. Remove those three things and the tree hash must be exactly the one above:

```bash
git checkout social-2026-11-13-1085b0f3fd9a
export GIT_INDEX_FILE="$(mktemp -u)"
git read-tree HEAD
git rm -q --cached BUILDING.md MODIFICATIONS.md
git restore --staged --source=a5affe62c74e39c1e7ac960d50d8418b807d532c -- \
  .github/workflows/build-containers.yml .github/workflows/staging-conflicts.yml
git write-tree      # prints d2014a650fd4806b8c9095de4fdc135aba7c220d
rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
```

## The changes, with their dates

1. **TikTok composer, 2026-07-16 and 2026-10-27.** The TikTok post settings follow TikTok's Content Posting
   API UX guidelines: privacy has no default and its options come from `creator_info`; comment, duet and
   stitch start unchecked and are greyed out when the creator disabled them; the Music Usage Confirmation
   is always shown for a direct post; the composer shows the creator's nickname; and the backend refuses a
   direct post with no privacy chosen instead of publishing it as public. The Business API composer, which
   has no `creator_info`, keeps its static privacy list (still with no default).
   Files: `apps/frontend/src/components/new-launch/providers/tiktok/tiktok.provider.tsx`,
   `libraries/nestjs-libraries/src/dtos/posts/providers-settings/tiktok.dto.ts`,
   `libraries/nestjs-libraries/src/integrations/social/tiktok.provider.ts`.
2. **Source code link, 2026-11-07.** `SOURCE_CODE_URL` renders a "Source code" link on every app page (the
   offer section 13 of the license asks for). Unset, or anything but an absolute http(s) URL, renders nothing.
   Files: `apps/frontend/src/app/(app)/layout.tsx`, `apps/frontend/src/components/layout/source.code.link.tsx`
   and its test.
3. **Data retention, 2026-11-10 and 2026-11-11.** A channel's access and refresh tokens are emptied when it is
   disconnected, deleted, or its workspace is closed, and when a provider deauthorizes it; a daily purge (a
   Temporal workflow) hard deletes a closed workspace's posts, media, comments, errors and channels 30 days after
   closure, and a deleted channel's rows 30 days after its deletion. Files: `apps/orchestrator/src/activities/retention.activity.ts`,
   `apps/orchestrator/src/retention.purge.starter.ts`, `apps/orchestrator/src/workflows/retention.purge.workflow.ts`,
   `libraries/nestjs-libraries/src/database/prisma/retention/`, `integration.repository.ts`,
   `refresh.integration.service.ts`, and their tests.
4. **Workspace provisioning route, 2026-11-10.** `PUT /public/v1/provisioning/workspaces/:externalRef` creates or
   returns a workspace, idempotent on a unique `externalRef`, open only to the holder of `PROVISIONING_TOKEN`
   (404 without it). Adds the column `Organization.externalRef` (nullable, unique) to `schema.prisma`. Files:
   `apps/backend/src/public-api/provisioning/`, `public.api.module.ts`,
   `libraries/nestjs-libraries/src/database/prisma/organizations/provisioning.*.ts`.
5. **Meta data deletion and deauthorize callbacks, 2026-11-12.** Meta's signed data deletion and deauthorize
   callbacks (verified with `FACEBOOK_APP_SECRET`), a deletion status page with an opaque code, and a Facebook or
   Instagram reconnect that stores the new login's id. Files: `apps/backend/src/meta-callbacks/`,
   `users.controller.ts`, `no.auth.integrations.controller.ts`, `integration.service.ts`, `users.service.ts`,
   `retention/deletion.code.ts`.
6. **Sign in under closed registration, 2026-11-12.** With `DISABLE_REGISTRATION=true`, existing users sign in by
   email, Google or Apple and every other address is refused by every provider; an owner route on the provisioning
   API sends the first set-password link; a reset link works once and is never a session; a Google token must be
   issued for this app. The sign in pages carry the Sedulia Social name, `TERMS_URL` and `PRIVACY_URL` links, and
   no testimonials (upstream's testimonial avatars and text are removed). Files: `apps/backend/src/services/auth/`,
   `apps/backend/src/public-api/provisioning/owner.*.ts`, `apps/frontend/src/app/(app)/auth/`,
   `apps/frontend/src/components/auth/`, `logo.tsx`, `logo-text.component.tsx`,
   `libraries/react-shared-libraries/src/helpers/testomonials.tsx`, `apps/frontend/public/auth/avatars/` (removed).
7. **Test workflow, 2026-11-12.** `.github/workflows/sedulia-jest.yml` runs the three jest configurations on pull
   requests into `sedulia/*` branches: tests only, no secrets, a read only token, nothing built or pushed.
8. **Comment wording, 2026-11-12.** Comments and test titles in the retention, sign in and Meta callback files
   reworded; no code change.
9. **Publication, 2026-11-13.** `BUILDING.md` and this file added. Upstream's `Build Containers` and
   `staging-conflicts` workflows run only in upstream's repository (`if: github.repository == 'gitroomhq/postiz-app'`),
   so this copy never builds or pushes an image or runs upstream's scheduled job.

Test configuration files (`jest.config.cjs` in `apps/frontend`, `apps/backend` and `libraries/nestjs-libraries`)
were added so the tests above run with `pnpm exec jest -c <that file>`.
