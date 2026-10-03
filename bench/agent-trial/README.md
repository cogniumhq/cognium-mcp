# agent-trial — a paired navigation trial

Does an agent answer a navigation question better with the MCP server than
without it? This is a **bench, not a graded pack run**: every number it
produces is reasoned from a bench and carries the limits below.

## Running it

```sh
# the repository under test, at the commit the oracle labels were drawn from
git clone https://github.com/WebGoat/WebGoat.git /tmp/webgoat
git -C /tmp/webgoat checkout 3284a8e466dfde083858f681e89aabb94e8b9c9e

npm ci && npm run build

node bench/agent-trial/sample.mjs <labels>/webgoat.json > bench/agent-trial/sample.json

REPO=/tmp/webgoat node bench/agent-trial/run.mjs \
  --sample bench/agent-trial/sample.json \
  --out bench/agent-trial/results.json \
  --harness claude,codex --repeats 3

node bench/agent-trial/grade.mjs \
  bench/agent-trial/results.json bench/agent-trial/sample.json > graded.json
```

`--sites N` and `--repeats N` cut the matrix down; the full one is
30 sites × 2 prompts × 2 harnesses × 2 configs × 3 repeats = **720 runs**.

## The design

**Paired.** The same site and the same prompt go to the same harness twice,
once with the server on stdio and once without. The difference is the server,
not the question. Run order is shuffled from the seed, so a warming cache or a
rate limit cannot land systematically on one arm.

**Two fixed prompts**, identical in both arms and not tuned:

- `list every caller of <target> in this repository`
- `which files would change if <target>'s signature changed`

**Same tool budget in both arms.** The baseline gets `Read, Grep, Glob, Bash`;
the MCP arm gets those plus the two navigation tools. Nothing else differs, and
no tool description is touched.

## What the grade means, and what it cannot mean

The oracle labels are a **500-site sample** of the repository, not a census, so
a target's caller set is a **lower bound**. A run that names a real caller the
sample never drew is not wrong — it is **off-sample**, counted beside the score
and never held against the run. So:

| | |
|---|---|
| `correct` | every labelled caller's file is named |
| `partial` | some but not all |
| `wrong` | none |

**This measures whether a run finds what the compiler found. It is not a
precision measure.** A run that listed every file in the repository would score
`correct`; only the off-sample count beside it shows that. Read the two
together or not at all.

Files, not line numbers, are the unit for both prompts: a caller answer that
names the right file and mangles a line is still the useful answer, and line
numbers drift with any edit.

**The sample is stratified by caller count** because of how the population
falls out: of 77 in-tree targets in the labels, only 17 have two or more
labelled callers. "List every caller" is an easy question on much of this
sample, and the strata keep that visible.
