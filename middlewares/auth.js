const User = require("./../models/user");

const auth = (req, res, next) => {
  const token = req.cookies.auth;
  User.findByToken(token, (err, user) => {
    if (err) throw err;
    req.token = token;

    // non-API call
    if (!req.originalUrl.startsWith("/api/")) {
      req.user = user;
      return next();
    }
    // API call
    const apiUrl = req.originalUrl.substr(5);
    const slashIndex = apiUrl.indexOf("/");
    const apiVersion = apiUrl.substr(0, slashIndex);
    const endpoint = apiUrl.substr(slashIndex + 1);

    if (apiVersion === "v1") {
      // logged-in user
      if (user) {
        // block non-admin users accessing the admin API
        if (endpoint.startsWith("admin") && user.role !== "admin") {
          return res.status(400).json({ auth: false, message: "The API is for admin users" });
        }
        req.user = user;
        return next();
      }

      // non-logged-in user
      if (endpoint.startsWith("project")) { // allow public access with API key
        if (endpoint.endsWith("segments")) { // bypass this exceptionally
          req.user = user;
          return next();
        }
        const apiKey = req.headers["x-api-key"];
        if (!apiKey) {
          return res.status(400).json({ auth: false, message: "Input API key not found" });
        }
        User.findOne({ apiKey }, (err, user) => {
          if (err) {
            return res.status(400).json({ error: true, message: err });
          }
          if (!user) {
            return res.status(400).json({ auth: false, message: "The API key is invalid" });
          }
          req.user = user;
          return next();
        });
      }
      else {
        return res.status(400).json({ auth: false, message: "User not logged in" });
      }
    }
    else {
      return res.status(400).json({ auth: false, message: "The API version is deprecated" });
    }
  });
}

module.exports = { auth };