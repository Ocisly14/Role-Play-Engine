---
id: forgery
title: Forgery
description: "Produce or alter fake documents, signatures, currency, or credentials to deceive scrutiny. Does NOT cover in-person impersonation (Disguise) or financial fraud through accounting (Accounting)."

skillCheck:
  skill: Forgery
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, conditions, inventory]
  scene:
    inject: [current]
    fields: [id, name, description]
  item:
    inject: [sceneItems, actorInventory]

outputSchema:
  presets: [default, item_modify]

interpreter:
  examples:
    - "Produce a forged travel pass bearing the official seal and correct date stamps"
    - "Reproduce the curator's signature on the acquisition letter to authorize access"
    - "Alter the original deed to change the property owner's name"
    - "Fabricate a press credential to gain entry to the restricted area"
    - "Copy the wax seal design onto the forged letter so it passes as authentic"
---

# Forgery Resolution Guidance

## State Changes
- Use `item.create` for the forged pass, signature sheet, credential, or replacement document that comes out of the attempt.
- Use `item.modify` when the actor alters an existing original, draft, seal, or partially prepared document.
- Use `item.destroy` when source materials, spoiled drafts, or ruined originals are consumed or rendered unusable.
- Use `item.move` when the finished forgery or working materials are handed off, hidden, pocketed, or otherwise relocated during the action.
- Use `memory.information` only when the actor learns a concrete technical detail about the original, seal, handwriting, or production method while studying it.

## On Success
- **Regular success**: The actor produces a convincing forgery that will pass casual inspection — a fake pass, a copied signature, or a reproduced credential (item.create). Untrained observers or a quick glance will not detect the fraud; the item can be used for its intended purpose under normal circumstances.
- **Hard success**: The forgery is of professional quality — it will hold up to moderate scrutiny, including examination by someone familiar with the genuine article. Fine details such as watermarks, official stamps, and paper texture have been carefully reproduced. The item grants full intended access or authorization.
- **Extreme success**: A masterwork forgery indistinguishable from the genuine document under most conditions — even an expert examiner would require special tools or a direct side-by-side comparison with the original to spot the fraud. The item is effectively as good as real for all practical purposes.

## On Failure
- The forgery is flawed — inconsistent ink, shaky handwriting, wrong paper stock, or a tell-tale error in the formatting reveals it as a fake to anyone who looks closely.
- The item produced (if any) is obviously suspect and will not survive scrutiny.
- If the attempt was on a specific original document, the original may be damaged or marked in the process.
- A fumble means the forgery is so poor it immediately raises suspicion, or the actor has left evidence of the attempt — ink stains on their hands, the discarded failed copies, or a witness who noticed what they were doing.
