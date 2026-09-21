export const getRequestInfo = (req) => {
    const ipAddress =
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.socket?.remoteAddress ||
        null;

    const userAgent = req.get('user-agent') || null;

    return {
        ipAddress,
        userAgent
    };
};