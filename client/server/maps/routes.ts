import fs from "fs";
import path from "path";
import express from "express";

const router = express.Router();

/**
 * Serve map images from module directories
 * GET /api/maps/:modulePath
 * Example: /api/maps/Cassandra's_Scenarios/map/Adolph's%20House.jpg
 *
 * Note: This endpoint is public (no authentication) since <img> tags
 * cannot send auth headers and maps are static game content.
 */
router.get("/*", (req, res) => {
  try {
    // Get the relative path from the URL
    const relativePath = (req.params as Record<string, string>)[0] || ""; // Everything after /maps/

    console.log("[Maps API] Request received for:", relativePath);
    console.log("[Maps API] Full URL:", req.url);

    // Security: prevent path traversal
    if (relativePath.includes("..") || relativePath.includes("//")) {
      console.log("[Maps API] Rejected: Path traversal attempt");
      return res.status(400).json({ error: "Invalid path" });
    }

    // Construct full path: data/Mods/[module]/[path]
    const modsDir = path.join(process.cwd(), "data", "Mods");

    // Find the module by checking if path exists
    const moduleNames = fs.readdirSync(modsDir);

    for (const moduleName of moduleNames) {
      const fullPath = path.join(modsDir, moduleName, relativePath);

      if (fs.existsSync(fullPath)) {
        // Verify file extension is allowed
        const ext = path.extname(fullPath).toLowerCase();
        if (
          ![".jpg", ".jpeg", ".png", ".webp", ".json", ".tsx"].includes(ext)
        ) {
          console.log("[Maps API] Rejected: Invalid file type:", ext);
          return res.status(400).json({ error: "Invalid file type" });
        }

        // Send the file
        console.log("[Maps API] Serving file:", fullPath);
        return res.sendFile(fullPath);
      }
    }

    // No matching file found
    console.log("[Maps API] File not found. Searched in:", modsDir);
    console.log("[Maps API] Available modules:", moduleNames);
    res.status(404).json({ error: "Map image not found" });
  } catch (error) {
    console.error("Error serving map image:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
