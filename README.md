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
and a fixture (a source course with a Unicode group and grouping, two target
courses, and on `moodlia` a Page with nested Unicode files). Images contain no
secrets: when a container starts, `php /opt/moodlia-lab/runtime.php <variant>`
sets a random administrator password and prints a fresh token.

Images are amd64 only. They are rebuilt weekly, when a plugin release triggers
`repository_dispatch` (`plugin-released`), or on demand
(`build-images.yml`). Build one locally with:

```sh
bash images/build.sh v4.5.12 moodlia moodlia-lab:4.5-moodlia ../moodle-local_moodlia
```

After the first push, set the `moodlia-lab` package visibility to public in
GitHub so pulls need no credentials.

## Live qualification

```sh
npm run qualify:live -- --source 4.5 --target 5.3 \
  --package ../moodlia-sync/moodlia-sync-0.1.0.tgz \
  --runner ../moodlia-sync/tools/live-qualification/runner
```

This starts four sites (Core and MoodlIA on each branch), runs plan, approve,
apply, verify, and an unchanged re-plan for the four provider pairings, writes
the report to `results/`, and removes every container, even on failure.
`--package` accepts a tarball or an npm version. `--database pgsql` installs
each site from the base image against its own PostgreSQL instead of SQLite;
it needs `--plugin <moodle-local_moodlia checkout>`.

Each container is limited to 768 MiB and 0.75 CPU (`--memory`, `--cpus`) and
labelled `moodlia-lab`, and PHP accepts uploads up to 1 GiB for large-backup
scenarios.

## GitHub Actions

- `qualify.yml`: reusable (`workflow_call`) and manual qualification of one
  source/target pair.
- `nightly.yml`: every source/target pair of the five branches, plus one
  PostgreSQL run.
- `.github/actions/lab-up`: starts one site and outputs its URL and a masked
  token, for other repositories' recording or integration jobs.

Actions minutes are free for public repositories on standard runners.

## Shared hosts

Prefer Actions. On a shared host, keep to two sites at a time and remove lab
images afterwards with `docker image prune --filter label=moodlia-lab`.

## License

GPL-3.0-or-later.
