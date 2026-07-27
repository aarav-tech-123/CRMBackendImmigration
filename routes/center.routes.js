import express from "express";
import {
  getAllCentres,
  getCentreById,
  getCentreByCode,
  createCentre,
  updateCentre,
  deleteCentre
} from "../controllers/center.controller.js";
import { authorize, verifyToken } from "../middleware/auth.middleware.js";

const router = express.Router();



// GET /api/centres - Get all active centres
router.get("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getAllCentres);

// GET /api/centres/:id - Get centre by ID
router.get("/:id", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getCentreById);

// GET /api/centres/code/:code - Get centre by code
router.get("/code/:code", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getCentreByCode);

// POST /api/centres - Create new centre
router.post("/", verifyToken, authorize(["SuperAdmin"]), createCentre);

// PUT /api/centres/:id - Update centre
router.put("/:id", verifyToken, authorize(["SuperAdmin"]), updateCentre);

// DELETE /api/centres/:id - Soft delete centre
router.delete("/:id", verifyToken, authorize(["SuperAdmin"]), deleteCentre);

export default router;

