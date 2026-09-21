import express from "express"
import { verifyToken, authorize } from "../../middleware/auth.middleware.js"
import { getAllDocumentStatuses } from "../../controllers/utils/documentStatus.controller.js"


const router = express.Router()


router.get("/", verifyToken, authorize(["Manager", "Agent", "SuperAdmin"]), getAllDocumentStatuses)



export default router;
