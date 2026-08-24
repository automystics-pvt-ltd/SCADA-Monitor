import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import mqttRouter from "./mqtt";
import weatherRouter from "./weather";
import platformAdminAuthRouter from "./platform-admin-auth";
import platformAdminRouter from "./platform-admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(mqttRouter);
router.use(weatherRouter);
router.use(platformAdminAuthRouter);
router.use(platformAdminRouter);

export default router;
