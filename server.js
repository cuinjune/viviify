const express = require("express");
const bodyparser = require("body-parser");
const requestIp = require("request-ip");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const path = require("path");
const config = require("./config/config");
const index = require("./routes/index");
const app = express();

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

// handle data in a nice way
app.use(bodyparser.urlencoded({ extended: false }));
app.use(bodyparser.json());
app.use(requestIp.mw()); // for getting req.clientIp
app.use(cookieParser());

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

// use the router
app.use("/", index);

// listening port
app.listen(config.PORT, () => {
    console.log(`Server is running localhost on port: ${config.PORT}`);
});
