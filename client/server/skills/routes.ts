import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as skillController from "./controller.js";

const router = Router();

router.use(authenticate);
router.post("/skills/suggest", skillController.suggestSkills);

export default router;
