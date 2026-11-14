// src/roleSim/tools/askFriend.ts
//
// The player character's line to the person playing them. Offered only while
// the player has handed the character over ("delegated"): the character runs
// on the same agent as everyone else, and this is the one extra thing they
// can do — ask their absent friend what they think. No NPC is ever offered it,
// and nothing in the world can see or hear the friend.

import type { ToolSpec } from "../../models/providers/types.js";

export const askFriendDoc = `---
name: askFriend
description: Ask your absent friend for advice. Terminates this decision.
---

# askFriend

You have a friend who is not here. Only you can talk to them: nobody around
you can see or hear them, and nothing you say to them reaches the world. When
something comes up that YOU judge to matter and you are genuinely unsure what
to do about it, you may ask them with \`askFriend\`, in your own voice.

What they tell you is advice. Weigh it the way this person would weigh a
trusted friend's word — and then decide for yourself. The choice stays yours.

Do not ask about small things: what to do with an ordinary minute is yours to
decide. Do not ask again about something you have already asked and they have
already answered — their answers are under **What your friend said**.

Asking ends this turn in place of \`act\` or \`continue\`. You wait for their
reply, and you decide again once it has reached you.

## Fields

- \`question\` (required): what you want to ask them, in your own words.`;

export const askFriendTool: ToolSpec = {
  name: "askFriend",
  noGrammar: true,
  description:
    "Ask your absent friend — whom only you can hear — for advice on something that matters to you and that you are genuinely unsure about. Their answer is advice; the decision stays yours. Terminates this decision: you decide again once they have replied.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "What you ask them, in your own words.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
};
