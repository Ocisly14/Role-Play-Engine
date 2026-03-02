import { Router } from "express";
import { listActiveSceneRooms } from "./controller.js";

const router = Router({ mergeParams: true });

router.get("/", listActiveSceneRooms);

export default router;
