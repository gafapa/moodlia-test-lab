# MoodlIA test lab

Disposable Moodle sites for testing MoodlIA packages against every supported
Moodle branch, without installing Moodle for each run.

## Golden images

`ghcr.io/gafapa/moodlia-lab:<branch>-<variant>` for branches 4.5, 5.0, 5.1,
5.2, and 5.3, in two variants:

- `core`: Moodle with REST enabled and a lab service exposing every Core
  function.
- `moodlia`: the same plus the MoodlIA plugin.

Each image is `erseco/alpine-moodle` with Moodle already installed on SQLite
and a fixture: a source course with a Unicode group and grouping, two target
courses, and on `moodlia` a Page with nested Unicode files. Course shortnames
carry the site (`M405CORE-SOURCE`, `M503MOODLIA-TARGET-A`), because
synchronization copies the source shortname and shortnames are unique per site.
Images contain no secrets: when a container starts,
`php /opt/moodlia-lab/runtime.php <variant>` sets a random administrator
password and prints the connection fixture (a fresh token and the course ids)
as JSON on its last line.

Images run Moodle in reverse-proxy mode with `SITE_URL` set to the host URL.
Publish them on a host port other than the container port 8080, for example
`-p 127.0.0.1:18080:8080 -e SITE_URL=http://127.0.0.1:18080`: when the host and
port match `wwwroot`, Moodle rejects every request as `reverseproxyabused`.

Images are amd64 only. They are rebuilt weekly, when a plugin release triggers
`repository_dispatch` (`plugin-released`), or on demand (`build-images.yml`,
with optional `plugin_ref` and a comma-separated `versions` list). Each build is
smoke-tested with a web service call before it is pushed. Build one locally with:

```sh
bash images/build.sh v4.5.12 moodlia moodlia-lab:4.5-moodlia ../moodle-local_moodlia
```

The `moodlia-lab` package is public: pulls need no credentials.

## Live qualification

```sh
npm run qualify:live -- --source 4.5 --target 5.3 \
  --package ../moodlia-sync/moodlia-sync-0.1.1.tgz \
  --runner ../moodlia-sync/tools/live-qualification/runner
```

This starts four sites (Core and MoodlIA on each branch), runs plan, approve,
apply, verify, and an unchanged re-plan for the four provider pairings, writes
the report to `results/`, and removes every container, even on failure. When a
run fails it also keeps the plans, CLI output, and synchronization state in
`results/<run-id>-evidence/` (never the tokens); if apply reports that a course
changed after planning, the evidence includes both courses exported twice.
`--package` accepts a tarball or an npm version. `--database pgsql` installs
each site from the base image against its own PostgreSQL instead of SQLite;
it needs `--plugin <moodle-local_moodlia checkout>`.

`--plugin-smoke` then exercises plugin write features on the target MoodlIA
site (group visibility and keys, text formats, embedded files for forum,
glossary, and Lesson, and a backup download); `--large-backup` streams a
backup larger than 100 MiB through upload, download, and restore.

Each container is limited to 768 MiB and 0.75 CPU (`--memory`, `--cpus`) and
labelled `moodlia-lab`, and PHP accepts uploads up to 1 GiB for large-backup
scenarios.

## GitHub Actions

- `qualify.yml`: reusable (`workflow_call`) and manual qualification of one
  source/target pair.
- `nightly.yml`: every source/target pair of the five branches, plus one
  PostgreSQL run.
- `.github/actions/lab-up`: starts one site and outputs its URL and a masked
  token, for other repositories' recording or integration jobs. Its `port`
  input defaults to 18080 and must not be 8080.

Actions minutes are free for public repositories on standard runners.

## Shared hosts

Prefer Actions. On a shared host, keep to two sites at a time and remove lab
images afterwards with `docker image prune --filter label=moodlia-lab`.

## License

GPL-3.0-or-later.
