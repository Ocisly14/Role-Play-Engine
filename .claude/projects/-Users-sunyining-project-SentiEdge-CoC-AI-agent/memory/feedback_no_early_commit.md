---
name: No early commits
description: Don't commit design docs or intermediate steps separately — commit everything together after all code changes are done
type: feedback
---

Don't commit design specs or intermediate artifacts separately. Complete all code modifications first, then commit everything together at the end.

**Why:** User prefers a single commit with all changes rather than incremental commits for specs/docs before implementation.

**How to apply:** When brainstorming produces a spec, skip the commit step. Write the spec file but wait until implementation is complete, then commit spec + code together.
