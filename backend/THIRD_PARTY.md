# TokenPulse core attribution

This directory incorporates `domain.py`, `rollout.py`, `tailer.py`, and `stats.py`
from [TokenPulse](https://github.com/zzccchen/token-pulse), fixed upstream commit
`edc27b1ab28709e6906667ef50decf12c7002e35` (v0.1.1), under the MIT license.
The quote-aware structural scanner in `submitted_settings.py` is adapted from
that same upstream's submissions parser.
The copyright notice and license are preserved in `TOKENPULSE-LICENSE.txt`.

Changes: the JSONL tailer immediately projects decoded records onto timing,
identity, observed model/effort and output-token fields; rollout parsing does not
collect provider, account mode, message input, or arbitrary notices from diagnostic
logs. The replacement `token_pulse/logs.py` queries bounded
`codex_core::stream_events_utils` timing rows and `feedback_tags` request-tier
metadata, plus bounded `codex_core::session::handlers` client submissions.
SQL removes feedback tails before Python receives them, then caps the safe
prefix; a long discarded feedback tail does not discard its short prefix. Only allowed
speed-tier values in `stream_request` metadata can label an output, matched to
its exact task/turn and generation interval. No upstream application, Qt code,
installer, build scripts, configuration reader, update feature, or network code
is used. Standard library modules implement the remaining collection/history
and JSON-lines protocol.

The tailer's rewrite-detection anchor is a SHA-256 digest instead of retained
raw tail bytes; an unfinished JSON line is the only retained undecoded source
buffer, bounded to 8 MiB.

Measured TPS is a completed-output estimate: output tokens divided by the
verified generation interval. Tool execution and pre-generation waiting are
excluded. Missing/ambiguous boundaries remain excluded samples, not zero TPS.
Configuration averages are weighted total tokens / total verified seconds.
Model, effort, submitted tier, requested tier and confirmed actual tier form exact groups;
missing fields remain unknown. Fast/priority and standard/default aliases are
canonicalized; auto remains distinct. Current source adapters do not establish
server-confirmed actual tiers, so that field remains unknown.

Client-submitted tier is a separate provenance field, not evidence of the wire
request or actual server tier. Only the exact handler target and structurally
recognized `Submission` / `TurnInput` / `ThreadSettingsOverrides` fields are
projected from a body capped at 16,000 characters. Quoted input and nested decoys
cannot supply those fields. The exact thread and turn identity plus timestamp
not later than the verified output start are required to label an output.
Missing start times, absent settings, explicit clearing and contradictory
settings remain unknown. A later contradictory observation can withdraw the
stored submitted label without changing TPS. Requested and submitted withdrawal
flags persist as two booleans; same-parser replay or log rotation cannot restore
a withdrawn tier. A newer parser revision can explicitly correct that decision.
No submission body is retained in
the evidence cache, renderer or history; only bounded tier/identity/timestamp
metadata remains. Unsupported handler formats remain unknown.

Read boundaries: an explicitly selected Codex root, the newest `state_*.sqlite`
and `logs_*.sqlite` files and their WAL files as binary reads, and contained JSONL
rollout paths. No source SQLite connection is opened: SQLite's nominal `mode=ro`
can change/create a source SHM file. Instead, each query uses a private temporary
DB/WAL mirror, never copies source SHM, and removes that mirror when the query
connection closes. Only the private mirror is opened with `mode=ro/query_only`.
Source identity, size, timestamps and header/tail digests are compared before
and after copying; changing or oversized sources are skipped for that poll.
Sources with a nonempty rollback journal are skipped rather than attempting
source recovery or reading possibly uncommitted pages.
The copy limit is 128 MiB combined DB+WAL per source (at most state and logs per
poll). Unchanged timing sources cache only fingerprints and parsed observations,
never complete databases between polls.

Physical temporary DB/WAL copies may contain private titles and diagnostic log
contents beyond the selected display/measurement fields. These files stay in
the private scratch directory, never enter the renderer or persistent history,
and are deleted after each query. The desktop owns a fresh scratch
root passed with `--scratch-dir` and cleans it after stopping its worker; normal
standalone shutdown cleans its own temporary root. An abrupt process/host crash
can leave temporary files until their owning desktop cleanup runs; no claim of
absolute crash-proof deletion is made.

No `config.toml`, `auth.json`, browser data, or keychain is opened. Bounded state-index
fields and `session_index.jsonl` supply only the user-requested local names:
current `name`, the latest index name, then legacy `title`; recognized child tasks
may use their short agent nickname. Metadata discovery is independent of rollout
availability, so an existing anonymous history row can receive a live display name.
Display titles are sanitized to at most 160 Unicode characters without controls
or line breaks, tied to the exact task's existing HMAC identity, and sent only in
the live sidecar/renderer snapshot. They are not passed to History or written to
its database, and renames update at the next bounded index discovery. Missing
title columns keep collection operational with anonymous display fallbacks.
Complete JSON lines briefly enter memory during decoding, then a
whitelist discards message/tool contents before normalization; a pending partial
line can remain buffered until completion. No raw record is written to history.

Persistent history contains anonymous HMAC task/turn/response keys, model,
effort, submitted/requested/actual tier, timestamps,
output tokens, timing source, parser revision, exclusion reason and the two tier
withdrawal booleans; retention
is 30 days / 10,000 samples. Parser revision 5 adds metadata columns and clears
unreliable older model attribution while preserving identities and measurements.
The submitted-tier column is an additive upgrade under revision 5 and preserves
all existing v5 labels and measurements. Available source replay can enrich these same records without duplication;
unavailable metadata remains unknown. Thread-index current settings are never
used to label historical output. The source and history directories must be disjoint,
including resolved symlinks. Demo mode creates both source and history in a
temporary directory and never touches a supplied Codex source. The desktop may
own a fresh `codex-tps-demo-*` temporary root and supply its `data` child; the
sidecar creates synthetic source/history only there, and the desktop cleans it
after stopping the sidecar. Standalone demo without `--data-dir` cleans its own
temporary root on normal exit.

Discovery uses the state index's update time to include old sessions continued
today (up to 512 recent updated sessions). If the index is missing/unreadable,
only recent dated session folders are probed. Parsing is bounded to 16 MiB and
32 files per poll, with complete-file catch-up over multiple polls.
The final tail read is capped to the remaining payload budget, and consumed
bytes are counted independently of offsets resetting on replacement. Small
fixed-size rewrite-detection anchor reads remain separate from that payload cap.
Timing-log backfill retains up to 40,000 relevant rows. The upstream normalizer retains
300 recent response boundaries per watched session for late timing repair;
extremely delayed timing beyond that buffer can remain excluded.

Snapshot schema 3 adds simultaneous conversation rows, including observed tasks
that have no completed sample yet. Per-task current observed configuration stays
separate from each historical output's profile; unknown fields are not filled
from a last output. A state older than 120 seconds is shown as unknown while its
observation timestamp remains available. This metadata describes local task
records, not the foreground OS window or a verified parent/subagent relationship.
Retained-history-only rows have no persisted title or current state.

Session source is projected only to an ephemeral `isSubagent` bit. Recognized
`source.subagent` structures identify child tasks; supported main-source strings
are classified separately and unsupported shapes stay unknown. The source
object, parent identities and nested source contents are discarded. Classification
is never inferred from a title, task ID, timing or presence of output, and never
stored in history. Demo includes one optional child task and two running parent
tasks that retain their latest completed TPS while a new output has no measurement.
