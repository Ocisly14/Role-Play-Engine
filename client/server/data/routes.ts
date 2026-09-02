import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as dataController from "./controller.js";

const router = Router();

router.get("/mods", authenticate, dataController.getMods);

export default router;
