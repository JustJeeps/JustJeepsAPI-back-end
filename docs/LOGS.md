# Run logs

Every cron run and every `seed-all` step writes its output to a file on the
droplet **and** uploads that run's output to DO Spaces.

## Why the archive exists

The files on disk are not a reliable record:

- They are opened in **append mode** and never rotate, so they grow without
  bound and mix many runs into one file.
- Container stdout is **lost on every deploy**. On 2026-08-07 the Keystone FTP
  error from the previous day was only recoverable because it happened to be in
  a file on a volume; the stdout of that run was already gone.

The archive gives one object per run, kept independently of the container.

## Layout in the bucket

```
logs/<source>/<command>/<YYYY>/<MM>/<DD>/<YYYYMMDDTHHMMSSZ>-<status>.log
```

- `source` is `cron` (the scheduled job itself) or `seed-all` (one of the steps
  inside the Daily Vendor Sync).
- `status` is `success` or `failed`, so a failed run is visible in the key.
- The `seed-all` summary goes up next to its steps as `...-<status>.summary.json`.

The date folders are there so a retention rule in the Spaces panel is a
one-liner, and so one day's runs stay together when reading by hand.

## Reading a log

```bash
npm run log-archive -- list                                   # most recent runs
npm run log-archive -- list --command seed-omix --failed      # only failures
npm run log-archive -- list --date 2026-08-07 --limit 50
npm run log-archive -- last --command feed-fetch-keystone     # print the newest
npm run log-archive -- get logs/cron/seed-all/2026/08/07/...log
```

In production, run it inside the container:

```bash
set -a; source .env.production; set +a
kamal app exec --reuse "npm run log-archive -- list --failed"
```

The cron panel also carries `lastLogArchiveKey` for each job, which is the key
of that job's most recent archived run.

## Configuration

Uses the same `DO_SPACES_*` credentials as the vendor feeds. Without them the
archive does nothing and logs keep working exactly as before.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOG_ARCHIVE_ENABLED` | `true` | Set to `false` to turn the upload off. |
| `DO_SPACES_LOGS_PREFIX` | `logs` | Prefix inside the bucket. |
| `LOG_ARCHIVE_MAX_BYTES` | `20971520` | Cap per run. Above it the **tail** is kept, with a header saying how much was omitted. |

## Guarantees

Archiving is bookkeeping and **never fails the work it observes**. A bucket
outage, a missing file or a permission error is logged as a warning and the
cron or seed carries on with its own exit code. This is covered by tests in
`test/lib/logArchive.test.js`.

## Naming trap

The source directories are `lib/logArchive/` and `services/logArchive/`, not
`lib/logs/`. Both `.gitignore` and `.dockerignore` contain a bare `logs/` rule,
which matches a directory with that name **at any depth** — source files placed
under a `logs/` directory are silently left out of the commit and out of the
image, and the server then fails to boot on `require`.
