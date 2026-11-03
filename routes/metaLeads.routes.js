import express from "express";
import { verifyToken, authorize } from "../middleware/auth.middleware.js";
import {
    verifyMetaWebhook,
    receiveMetaWebhook,
    processPendingMetaLeads,
    listMetaStaging
} from "../controllers/metaLeads.controller.js";

const router = express.Router();

const auth = [verifyToken, authorize(["SuperAdmin", "Manager"])];

// Called by Meta (verified by verify token / HMAC signature, not JWT)
router.get("/webhook", verifyMetaWebhook);
router.post("/webhook", receiveMetaWebhook);

// Internal
router.post("/leads/process", ...auth, processPendingMetaLeads);
router.get("/leads/staging", ...auth, listMetaStaging);

export default router;
