# How This Wiki Was Built

## The Problem
29 Claude Code sessions for this project — some over 3MB each. Too much to read, impossible to reference, no way to know what was decided or left open.

## The Solution
A Python script (`~/Desktop/Journaler/index-sessions.py`) that:
1. Reads every `.jsonl` session file from `~/.claude/projects/` (and `~/Documents/ClaudeSessions/` for older sessions no longer in the live dir)
2. Strips all noise — tool calls, bash outputs, file reads, timestamps, JSON overhead (~95% of each file)
3. Sends the clean conversation text to **GPT-4o mini** in batches of 40 turns
4. GPT tags and describes each meaningful turn: `DECISION`, `INSIGHT`, `TASK`, `BUG`, `QUESTION`, `INFO`
5. Groups turns where nothing new happened, gives individual entries where something meaningful did
6. Outputs per-session `.md` index files and a merged `master-index.md` cross-referenced by topic

## Total Cost
~$0.06 for all 29 sessions.

## Folder Structure

```
session-context/
  HOW-THIS-WIKI-WAS-BUILT.md   ← this file
  master-index.md              ← topic cross-reference across all sessions
  {date}-{id}.md               ← turn-by-turn index for one session
  {date}-{id}.txt              ← full clean conversation text, turn-numbered
```

## How Each File Is Connected

Each `.md` index file contains:
- `**Full ID**` — the original session UUID
- `**Source**` — path to the raw `.jsonl` file (if you need the full unstripped version)
- `**Text**` — path to the clean `.txt` file (what an agent should read)

The `master-index.md` references `{date}-{id}.md:Turn N` so you can trace:
```
master-index.md → session .md (find the turn) → session .txt (read the content)
```

## How to Use With an Agent

Start a new session in this project and say:
> "Read session-context/master-index.md and tell me what we decided about X"

Or for deep context on a specific topic:
> "In session-context/master-index.md find entries about the recommendation engine, then read those turns from the relevant .txt file"

The agent reads the index (~1-2k tokens) to locate the right turns, then reads only those lines from the `.txt` — not the whole session.

## How to Update

When new sessions accumulate, run:
```bash
export OPENAI_API_KEY=sk-...
python3 ~/Desktop/Journaler/index-sessions.py
```

It skips already-indexed sessions automatically and only processes new ones. Then copy the updated files here:
```bash
cp -r ~/Desktop/Journaler/session-wiki/community-connector-agent/* \
      ~/Desktop/dev/community-connector-agent/session-context/
```
