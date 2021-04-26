const express = require("express");
const requestIp = require("request-ip");
const bodyparser = require("body-parser");
const cookieParser = require("cookie-parser");
const favicon = require("serve-favicon");
const mongoose = require("mongoose");
const path = require("path");
const config = require("./config/config");
const index = require("./routes/index");
const app = express();
const { RateLimiterMemory } = require("rate-limiter-flexible");

// rate limiter middleware (max 10 requests per second)
const rateLimiter = new RateLimiterMemory(
    {
        points: 10,
        duration: 1,
        blockDuration: 60
    }
);
const rateLimiterMiddleware = (req, res, next) => {
    rateLimiter.consume(req.clientIp).then(() => {
        next();
    }).catch((rejRes) => {
        const secs = Math.round(rejRes.msBeforeNext / 1000) || 1;
        res.set("Retry-After", String(secs));
        const message = `Too many requests made, please retry after ${secs} seconds`;
        if (req.originalUrl.startsWith("/api/")) {
            return res.status(429).json({ error: true, message });
        }
        return res.render("error.ejs", { status: 429, message });
    });
};

// database connection
mongoose.Promise = global.Promise;
mongoose.connect(config.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true, useCreateIndex: true, useFindAndModify: false }, (err) => {
    if (err) {
        console.log(err);
        return;
    }
    console.log("database is connected");
});

// paths
const publicPath = path.join(__dirname, "public");
const viewsPath = path.join(__dirname, "views");

// set views
app.set("views", viewsPath);
app.set("view engine", "ejs");

// this has to do with "proxy_set_header X-Forwarded-For $remote_addr;" in nginx config file (/etc/nginx/sites-available/default)
app.set("trust proxy", true);

// handle data in a nice way
app.use(bodyparser.urlencoded({ extended: false }));
app.use(bodyparser.json());
app.use(requestIp.mw()); // for getting req.clientIp
app.use(cookieParser());
app.use(favicon(path.join(`${publicPath}/asset/favicon`, "favicon.ico")));

// set your static server
app.use(express.static(publicPath));
app.use(express.static(viewsPath));

// remove trailing slash
app.use((req, res, next) => {
    if (req.path.substr(-1) === "/" && req.path.length > 1) {
        const query = req.url.slice(req.path.length);
        res.redirect(301, req.path.slice(0, -1) + query);
    } else {
        next();
    }
});

// handle client ip address
app.use((req, res, next) => {
    req.clientIp = req.clientIp.replace(/^.*:/, ""); // strip the IPv6 prefix to make it IPv4
    next();
});

// set rate limiter
app.use(rateLimiterMiddleware);

// use the router
app.use("/", index);

// listening port
app.listen(config.PORT, () => {
    console.log(`Server is running localhost on port: ${config.PORT}`);
});
