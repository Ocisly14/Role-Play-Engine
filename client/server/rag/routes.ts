import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as ragController from "./controller.js";

const router = Router();

router.use(authenticate);
router.post("/rag/ask", ragController.askRag);

export default router;
