import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as characterController from "./controller.js";

const router = Router();

// Character management endpoints
router.use(authenticate);
router.post(
  "/character/random-attributes",
  characterController.generateRandomAttrs
);
router.post("/character", characterController.createCharacter);
router.get("/characters", characterController.getAllCharacters);
router.get("/character/:characterId", characterController.getCharacterById);

export default router;
