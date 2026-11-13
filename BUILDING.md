# Building and running this source

This repository is the source code of Sedulia Social: a modified version of
[Postiz](https://github.com/gitroomhq/postiz-app), licensed under the GNU Affero General Public License
version 3 (see `LICENSE`). Each tag named `social-<date>-<commit>` is the source of one deployed build. What
changed against Postiz, with dates, is in `MODIFICATIONS.md`.

## What the build uses

- Base: upstream Postiz `v2.25.3` (commit `a5affe62c74e39c1e7ac960d50d8418b807d532c`), which is this
  commit's parent.
- `Dockerfile.dev` from this tree, unchanged from upstream. Its base image is `node:22.23.4-bookworm-slim`; it
  installs `pnpm@10.6.1` and `pm2` with npm, copies the whole tree (`COPY . /app`), runs `pnpm install` and
  `pnpm run build`, and starts nginx and the apps with `pnpm run pm2`.
- One build argument, `NEXT_PUBLIC_VERSION`, the commit the image was built from. It is baked in and shown by
  the app as its version.
- Platform `linux/amd64`.

## The exact build command

From a clean checkout of the tag (no untracked files: the Dockerfile copies everything in the folder into the
image):

```bash
git checkout <tag>
git status --porcelain            # must print nothing
docker build --platform linux/amd64 -f Dockerfile.dev \
  --build-arg NEXT_PUBLIC_VERSION=<the commit named in MODIFICATIONS.md> \
  -t sedulia-social:<short commit> .
```

For the tag `social-2026-11-13-1085b0f3fd9a` that is
`--build-arg NEXT_PUBLIC_VERSION=1085b0f3fd9aa11d0634066542cc0db2a6d80607`, the value the deployed image
carries.

The deployed image was built from a tree that is this tag without `BUILDING.md`, `MODIFICATIONS.md` and the
four `if:` lines in `.github/workflows/` (none of them is used by the running app). `MODIFICATIONS.md`, "How to
check this tag against the deployed build", shows how to rebuild that exact tree and compare its hash.

## Running it

Postiz needs PostgreSQL, Redis and Temporal beside the app. Upstream's `docker-compose.yaml` in this tree runs
that whole set; to run this build, replace the `image:` of the `postiz` service with the image you built and
set the environment below. The app listens on port 5000 inside the container (nginx in front of the frontend
on 4200 and the backend on 3000). On every start the backend applies the database schema
(`prisma db push`), which also adds the column this version introduces (see `MODIFICATIONS.md`).

```bash
docker compose -f docker-compose.yaml up -d
```

The environment names are upstream's (see `.env.example` and the Postiz documentation), plus the ones these
modifications read:

| Name | What it does when set | When unset or empty |
|---|---|---|
| `SOURCE_CODE_URL` | Shows a "Source code" link in the corner of every app page, to that http(s) URL | No link |
| `PROVISIONING_TOKEN` | Enables `PUT /public/v1/provisioning/workspaces/:externalRef` and its owner route, for a caller that sends this token | Those routes answer 404 |
| `TERMS_URL`, `PRIVACY_URL` | Links to the operator's Terms and Privacy pages on the sign in pages | No links |
| `DISABLE_REGISTRATION` | Upstream's flag. Set to `true`, an address that already has a user signs in (email, Google or Apple) and every other address is refused by every provider, generic OAuth included; nothing new is created | Registration as upstream |
| `FACEBOOK_APP_SECRET` | Upstream's name; also verifies Meta's signed data deletion and deauthorize callbacks | Those callbacks refuse |

Never put a real secret in this repository or in the build context. Every value above is set at run time.
