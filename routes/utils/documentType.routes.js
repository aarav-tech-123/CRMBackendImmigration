import express from "express"
import { verifyToken, authorize } from "../../middleware/auth.middleware.js"
import { getAllDocumentTypes } from "../../controllers/utils/documentType.controller.js"


const router = express.Router()


router.get("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getAllDocumentTypes)



export default router;
