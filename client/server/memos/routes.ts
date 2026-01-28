import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as memoController from "./controller.js";

const router = Router();

router.use(authenticate);

router.get("/memos", memoController.listMemos);
router.post("/memos", memoController.createMemo);
router.put("/memos/:memoId", memoController.updateMemo);
router.delete("/memos/:memoId", memoController.deleteMemo);

export default router;
