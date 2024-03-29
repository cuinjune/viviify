const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const validator = require("email-validator");
const geoip = require("geoip-lite");
const short = require("short-uuid");
const { v4: uuidv4 } = require("uuid");
const User = require("./../models/user");
const Project = require("./../models/project");
const config = require("./../config/config");
const { auth } = require("./../middlewares/auth");
const { RateLimiterMemory } = require("rate-limiter-flexible");

// rate limiter for basic users (max 50 requests per hour)
const rateLimiterBasic = new RateLimiterMemory(
  {
    points: 50,
    duration: 60 * 60,
    blockDuration: 60 * 60
  }
);

// rate limiter for premium and admin users (max 100 requests per hour)
const rateLimiterPremium = new RateLimiterMemory(
  {
    points: 100,
    duration: 60 * 60,
    blockDuration: 60 * 60
  }
);

// // server under maintenance
// router.get("*", (req, res) => {
//   return res.render("error.ejs", { status: 207, message: "Sorry, the server is under maintenance" });
// });

// views
router.get("/", auth, (req, res) => {
  if (req.user) {
    return res.redirect("/app");
  }
  return res.render("index.ejs");
});

router.get("/login", auth, (req, res) => {
  if (req.user) {
    return res.redirect("/app");
  }
  return res.render("login.ejs");
});

router.get("/signup", auth, (req, res) => {
  if (req.user) {
    return res.redirect("/app");
  }
  return res.render("signup.ejs");
});

router.get("/app", auth, (req, res) => {
  if (!req.user) {
    return res.redirect("/login");
  }
  return res.render("app.ejs");
});

router.get("/account", auth, (req, res) => {
  if (!req.user) {
    return res.redirect("/login");
  }
  return res.render("account.ejs", { email: req.user.email, name: req.user.name });
});

router.get("/name", auth, (req, res) => {
  if (!req.user) {
    return res.redirect("/login");
  }
  return res.render("name.ejs", { name: req.user.name });
});

router.get("/password", auth, (req, res) => {
  if (!req.user) {
    return res.redirect("/login");
  }
  return res.render("password.ejs");
});

router.get("/delete", auth, (req, res) => {
  if (!req.user) {
    return res.redirect("/login");
  }
  return res.render("delete.ejs");
});

router.get("/edit/:urlKey", auth, (req, res) => {
  if (!req.user) {
    return res.redirect("/login");
  }
  Project.findOne({ urlKey: req.params.urlKey }, (err, project) => {
    if (err) {
      return res.render("error.ejs", { status: 400, message: err });
    }
    if (!project) {
      return res.render("error.ejs", { status: 404, message: "Page not found" });
    }
    return res.render("edit.ejs", { role: req.user.role, text: project.text, voice: project.voice, speed: project.speed, subtitle: project.subtitle, urlKey: project.urlKey });
  });
});

router.get("/embed/:urlKey", (req, res) => {
  Project.findOne({ urlKey: req.params.urlKey }, (err, project) => {
    if (err) {
      return res.render("error.ejs", { status: 400, message: err });
    }
    if (!project) {
      return res.render("embed.ejs", { voice: "", subtitle: "", urlKey: "" }); // the video no longer exists
    }
    return res.render("embed.ejs", { voice: project.voice, subtitle: project.subtitle, urlKey: project.urlKey });
  });
});

router.get("/watch/:urlKey", (req, res) => {
  Project.findOne({ urlKey: req.params.urlKey }, (err, project) => {
    if (err) {
      return res.render("error.ejs", { status: 400, message: err });
    }
    if (!project) {
      return res.render("watch.ejs", { urlKey: req.params.urlKey });
    }
    return res.render("watch.ejs", { urlKey: project.urlKey });
  });
});

// request video url to flask (called from embed.ejs)
router.post("/api/v1/video", (req, res) => {
  fetch("http://localhost:8001/api/v1/flask/video", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(req.body)
  }).then(response => response.json()).then((data) => {
    return res.status(200).json(data);
  });
});

// get sorted array of projects in {urlKey, previewText} format (called from app.ejs)
router.get("/api/v1/projects", auth, (req, res) => {
  const newText = Project.getValidText(req.query.q);
  req.user.populate({ path: "projects", options: { sort: { lastModifiedDate: -1 } } }, (err, user) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    const previewTextLength = 200;
    const projects = [];
    for (const project of user.projects) {
      if (newText.length && project.text.search(new RegExp(newText, "i")) === -1) {
        continue;
      }
      const urlKey = project.urlKey;
      const previewText = project.text.trim().substr(0, previewTextLength);
      projects.push({ urlKey, previewText });
    }
    return res.status(200).json({
      auth: true,
      message: "Successfully got projects",
      projects
    });
  });
});

// create a new project (called from app.ejs)
router.post("/api/v1/project", auth, (req, res) => {
  const maxNumProjects = req.user.role === "basic" ? 10 : 100;
  if (req.user.projects.length === maxNumProjects) {
    return res.status(400).json({ auth: false, message: `You have reached the maximum number of projects allowed (${maxNumProjects}) for your account` });
  }
  const generateUrlKey = () => {
    const urlKey = short.generate().substr(0, 11);
    Project.findOne({ urlKey }, (err, project) => {
      if (err) {
        return res.status(400).json({ error: true, message: err });
      }
      if (project) {
        generateUrlKey();
        return;
      }
      const newData = {};
      newData.urlKey = urlKey;
      newData.user = req.user._id;
      newData.createdDate = new Date().toISOString();
      newData.lastModifiedDate = newData.createdDate;
      newData.segments = [];
      const newProject = new Project(newData);
      User.findByIdAndUpdate({ _id: req.user._id }, { $push: { projects: newProject._id } }, { new: true }, (err, user) => {
        if (err) {
          return res.status(400).json({ error: true, message: err });
        }
        newProject.save((err, project) => {
          if (err) {
            return res.status(400).json({ error: true, message: err });
          }
          return res.status(200).json({
            auth: true,
            message: "Successfully created a new project",
            urlKey
          });
        });
      });
    });
  }
  generateUrlKey();
});

// get project by urlKey (called from embed.ejs)
router.get("/api/v1/project/:urlKey", (req, res) => {
  Project.findOne({ urlKey: req.params.urlKey }, (err, project) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    if (!project) {
      return res.status(400).json({ auth: false, message: "Incorrect URL key" });
    }
    return res.status(200).json({
      auth: true,
      message: "Successfully got the project",
      project
    });
  });
});

// update project by urlKey (called from edit.ejs)
router.put("/api/v1/project/:urlKey", auth, (req, res) => {
  Project.findOne({ urlKey: req.params.urlKey }, (err, project) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    if (!project) {
      return res.status(400).json({ auth: false, message: "Incorrect URL key" });
    }
    if (!project.user.equals(req.user._id)) {
      return res.status(400).json({ auth: false, message: "You cannot update other user's project" });
    }
    // all of these settings are optional and it will only update given ones
    const { text, voice, speed, subtitle } = req.body;
    const updatedData = { text: project.text, voice: project.voice, speed: project.speed, subtitle: project.subtitle };
    if (typeof text === "string") {
      const maxNumCharacters = req.user.role === "basic" ? 3000 : 12000;
      updatedData.text = Project.getValidText(text).substr(0, maxNumCharacters);
    }
    if (voice) {
      if (!Project.validateVoice(voice)) {
        return res.status(400).json({ auth: false, message: "Invalid input voice" });
      }
      updatedData.voice = voice;
    }
    if (speed) {
      if (!Project.validateSpeed(speed)) {
        return res.status(400).json({ auth: false, message: "Invalid input speed" });
      }
      updatedData.speed = speed;
    }
    if (subtitle) {
      if (!Project.validateSubtitle(subtitle)) {
        return res.status(400).json({ auth: false, message: "Invalid input subtitle" });
      }
      updatedData.subtitle = subtitle;
    }
    if (updatedData.text === project.text && updatedData.voice === project.voice && updatedData.speed === project.speed && updatedData.subtitle === project.subtitle) {
      return res.status(200).json({
        auth: true,
        message: "No update was made to the project"
      });
    }
    const rateLimiter = req.user.role === "basic" ? rateLimiterBasic : rateLimiterPremium;
    rateLimiter.consume(req.user._id).then(() => {
      fetch("http://localhost:8001/api/v1/flask/keywords", {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ text: updatedData.text })
      }).then(response => response.json()).then((data) => {
        if (!data.auth) {
          return res.status(200).json(data);
        }
        updatedData.keywords = data.keywords;
        project.getSegments(updatedData, (err, data) => {
          if (err) {
            return res.status(400).json({ error: true, message: err });
          }
          data.lastModifiedDate = new Date().toISOString();
          Project.findOneAndUpdate({ urlKey: req.params.urlKey }, data, { new: true }, (err, project) => {
            if (err) {
              return res.status(400).json({ error: true, message: err });
            }
            return res.status(200).json({
              auth: true,
              message: "Successfully updated the project"
            });
          });
        });
      });
    }).catch((rejRes) => {
      const secs = Math.round(rejRes.msBeforeNext / 1000) || 1;
      res.set("Retry-After", String(secs));
      return res.status(429).json({ auth: false, message: `You have reached the limit of requests allowed (${rateLimiter.points} / hour) for your account` });
    });
  });
});

// update project segments by urlKey (called from edit.ejs)
router.put("/api/v1/project/:urlKey/segments", auth, (req, res) => {
  Project.findOne({ urlKey: req.params.urlKey }, (err, project) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    if (!project) {
      return res.status(400).json({ auth: false, message: "Incorrect URL key" });
    }
    if (!project.user.equals(req.user._id)) {
      return res.status(200).json({ auth: false, message: "You cannot update other user's segments" });
    }
    const { videoData } = req.body;
    if (typeof videoData !== "object" || videoData == null) {
      return res.status(400).json({ auth: false, message: "Invalid input videoData" });
    }
    const segments = project.segments;
    for (let index in videoData) {
      index = parseInt(index, 10);
      if (!Number.isInteger(index) || index < 0 || index > segments.length - 1 || segments[index].type !== "video") {
        return res.status(400).json({ auth: false, message: "Invalid input index" });
      }
      const videos = videoData[index].videos;
      if (!Array.isArray(videos)) {
        return res.status(400).json({ auth: false, message: "Invalid input videos" });
      }
      const videoIndex = videoData[index].videoIndex;
      if (!Number.isInteger(videoIndex) || videoIndex < 0 || videoIndex > videos.length - 1) {
        return res.status(400).json({ auth: false, message: "Invalid input videoIndex" });
      }
      segments[index].videos = videos;
      segments[index].videoIndex = videoIndex;
    }
    Project.findOneAndUpdate({ urlKey: req.params.urlKey }, { segments }, { new: true }, (err, project) => {
      if (err) {
        return res.status(400).json({ error: true, message: err });
      }
      return res.status(200).json({
        auth: true,
        message: "Successfully updated the segments"
      });
    });
  });
});

// delete project by urlKey (called from app.ejs)
router.delete("/api/v1/project/:urlKey", auth, (req, res) => {
  Project.findOne({ urlKey: req.params.urlKey }, (err, project) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    if (!project) {
      return res.status(400).json({ auth: false, message: "Incorrect URL key" });
    }
    if (!project.user.equals(req.user._id)) {
      return res.status(400).json({ auth: false, message: "You cannot delete other user's project" });
    }
    User.findByIdAndUpdate({ _id: req.user._id }, { $pull: { projects: project._id } }, { new: true }, (err, user) => {
      if (err) {
        return res.status(400).json({ error: true, message: err });
      }
      Project.findOneAndDelete({ urlKey: req.params.urlKey }, (err, project) => {
        if (err) {
          return res.status(400).json({ error: true, message: err });
        }
        return res.status(200).json({
          auth: true,
          message: "Successfully deleted the project"
        });
      });
    });
  });
});

// adding new user (sign-up route)
router.post("/api/v1/user/signup", (req, res) => {
  const { email, password, name, secret } = req.body;
  if (!email) {
    return res.status(400).json({ auth: false, message: "Input email not found" });
  }
  if (!validator.validate(email)) {
    return res.status(400).json({ auth: false, message: "Invalid email to use" });
  }
  if (!password) {
    return res.status(400).json({ auth: false, message: "Input password not found" });
  }
  if (!User.validatePassword(password)) {
    return res.status(400).json({ auth: false, message: "Invalid password to use" });
  }
  if (!name) {
    return res.status(400).json({ auth: false, message: "Input name not found" });
  }
  if (!User.validateName(name)) {
    return res.status(400).json({ auth: false, message: "Invalid name to use" });
  }
  const generateApiKey = () => {
    const apiKey = uuidv4();
    User.findOne({ apiKey }, (err, user) => {
      if (err) {
        return res.status(400).json({ error: true, message: err });
      }
      if (user) {
        generateApiKey();
        return;
      }
      const role = email === "admin@viviify.com" && secret === config.SECRET ? "admin" : "basic";
      const signupDate = new Date().toISOString();
      const geo = geoip.lookup(req.clientIp);
      const country = geo ? geo.country : "unknown";
      const region = geo ? geo.region : "unknown";
      const city = geo ? geo.city : "unknown";
      const newUser = new User({ email, password, name, role, apiKey, signupDate, country, region, city });
      User.findOne({ email: newUser.email }, (err, user) => {
        if (err) {
          return res.status(400).json({ error: true, message: err });
        }
        if (user) {
          return res.status(400).json({ auth: false, message: "Email exists" });
        }
        const generateUrlKey = () => {
          const urlKey = short.generate().substr(0, 11);
          Project.findOne({ urlKey }, (err, project) => {
            if (err) {
              return res.status(400).json({ error: true, message: err });
            }
            if (project) {
              generateUrlKey();
              return;
            }
            const saveUser = () => {
              newUser.save((err, user) => {
                if (err) {
                  return res.status(400).json({ error: true, message: err });
                }
                return res.status(200).json({
                  auth: true,
                  message: "Successfully signed up the user"
                });
              });
            }
            User.findOne({ email: "example@viviify.com" }, (err, user) => {
              if (err) {
                return res.status(400).json({ error: true, message: err });
              }
              if (!user) {
                saveUser();
                return;
              }
              user.populate({ path: "projects", options: { sort: { lastModifiedDate: -1 } } }, (err, user) => {
                if (err) {
                  return res.status(400).json({ error: true, message: err });
                }
                if (!user.projects.length || !user.projects[0].segments.length) {
                  saveUser();
                  return;
                }
                const text = user.projects[0].text;
                const voice = user.projects[0].voice;
                const speed = user.projects[0].speed;
                const subtitle = user.projects[0].subtitle;
                const createdDate = signupDate;
                const lastModifiedDate = createdDate;
                const keywords = user.projects[0].keywords;
                const segments = user.projects[0].segments;
                const newProject = new Project({ text, voice, speed, subtitle, user: newUser._id, urlKey, createdDate, lastModifiedDate, keywords, segments });
                newProject.save((err, project) => {
                  if (err) {
                    return res.status(400).json({ error: true, message: err });
                  }
                  newUser.projects.push(newProject._id);
                  saveUser();
                  return;
                });
              });
            });
          });
        }
        generateUrlKey();
      });
    });
  }
  generateApiKey();
});

// login user
router.post("/api/v1/user/login", (req, res) => {
  const { email, password } = req.body;
  if (!email) {
    return res.status(400).json({ auth: false, message: "Input email not found" });
  }
  if (!validator.validate(email)) {
    return res.status(400).json({ auth: false, message: "Invalid email" });
  }
  if (!password) {
    return res.status(400).json({ auth: false, message: "Input password not found" });
  }
  if (!User.validatePassword(password)) {
    return res.status(400).json({ auth: false, message: "Invalid password" });
  }
  const token = req.cookies.auth;
  User.findByToken(token, (err, user) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    if (user) {
      return res.status(400).json({ auth: false, message: "You are already logged in" });
    }
    User.findOne({ email }, (err, user) => {
      if (err) {
        return res.status(400).json({ error: true, message: err });
      }
      if (!user) {
        return res.status(400).json({ auth: false, message: "Incorrect email or password" }); // email not found
      }
      user.comparePassword(password, (err, isMatch) => {
        if (err) {
          return res.status(400).json({ error: true, message: err });
        }
        if (!isMatch) {
          return res.status(400).json({ auth: false, message: "Incorrect email or password" }); // incorrect password
        }
        const updatedData = {};
        const geo = geoip.lookup(req.clientIp);
        if (geo) {
          // Note: later, if the user's country has been changed, prevent login and ask for email confirmation
          updatedData.country = geo.country;
          updatedData.region = geo.region;
          updatedData.city = geo.city;
        }
        updatedData.numVisits = user.numVisits + 1;
        updatedData.lastLoginDate = new Date().toISOString();
        user.generateToken((err, user) => {
          if (err) {
            return res.status(400).json({ error: true, message: err });
          }
          User.findByIdAndUpdate({ _id: user._id }, updatedData, { new: true }, (err, user) => {
            if (err) {
              return res.status(400).json({ error: true, message: err });
            }
            return res.cookie("auth", user.token).json({
              auth: true,
              message: "Successfully logged in the user"
            });
          });
        });
      });
    });
  });
});

// logout user
router.get("/api/v1/user/logout", auth, (req, res) => {
  req.user.deleteToken(req.token, (err, user) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    return res.status(200).json({
      auth: true,
      message: "Successfully logged out the user"
    });
  });
});

// get user's account
router.get("/api/v1/user/account", auth, (req, res) => {
  return res.status(200).json({
    auth: true,
    message: "Successfully got the user account",
    id: req.user._id,
    email: req.user.email,
    name: req.user.name,
    role: req.user.role,
    apiKey: req.user.apiKey,
    signupDate: req.user.signupDate,
    country: req.user.country,
    region: req.user.region,
    city: req.user.city,
    numVisits: req.user.numVisits,
    lastLoginDate: req.user.lastLoginDate,
    timeSpent: req.user.timeSpent,
    emailConfirmed: req.user.emailConfirmed
  });
});

// delete user's account
router.put("/api/v1/user/account", auth, (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ auth: false, message: "Input password not found" });
  }
  req.user.comparePassword(password, (err, isMatch) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    if (!isMatch) {
      return res.status(400).json({ auth: false, message: "The password is incorrect" });
    }
    User.findByIdAndDelete({ _id: req.user._id }, (err, user) => {
      if (err) {
        return res.status(400).json({ error: true, message: err });
      }
      // delete all projects belong to the user
      Project.deleteMany({ _id: { $in: user.projects } }, (err, result) => {
        if (err) {
          return res.status(400).json({ error: true, message: err });
        }
        req.user.deleteToken(req.token, (err, user) => {
          if (err) {
            return res.status(400).json({ error: true, message: err });
          }
          return res.status(200).json({
            auth: true,
            message: "Successfully deleted the user account"
          });
        });
      });
    });
  });
});

// update user's password
router.put("/api/v1/user/password", auth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword) {
    return res.status(400).json({ auth: false, message: "Input currentPassword not found" });
  }
  if (!newPassword) {
    return res.status(400).json({ auth: false, message: "Input newPassword not found" });
  }
  req.user.comparePassword(currentPassword, (err, isMatch) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    if (!isMatch) {
      return res.status(400).json({ auth: false, message: "The current password is incorrect" });
    }
    if (!User.validatePassword(newPassword)) {
      return res.status(400).json({ auth: false, message: "Invalid password to update" });
    }
    User.getHashedPassword(newPassword, (err, hash) => {
      if (err) {
        return res.status(400).json({ error: true, message: err });
      }
      User.findByIdAndUpdate({ _id: req.user._id }, { password: hash }, { new: true }, (err, user) => {
        if (err) {
          return res.status(400).json({ error: true, message: err });
        }
        return res.status(200).json({
          auth: true,
          message: "Successfully updated the password"
        });
      });
    });
  });
});

// update user's name
router.put("/api/v1/user/name", auth, (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ auth: false, message: "Input name not found" });
  }
  if (!User.validateName(name)) {
    return res.status(400).json({ auth: false, message: "Invalid name to update" });
  }
  User.findByIdAndUpdate({ _id: req.user._id }, { name }, { new: true }, (err, user) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    return res.status(200).json({
      auth: true,
      message: "Successfully updated the name"
    });
  });
});

// update user's time spent (updated every second while on app.ejs or edit.ejs)
router.put("/api/v1/user/timespent", auth, (req, res) => {
  const timeSpent = req.user.timeSpent + 1 / 60;
  User.findByIdAndUpdate({ _id: req.user._id }, { timeSpent }, { new: true }, (err, user) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    return res.status(200).json({
      auth: true,
      message: "Successfully updated the timeSpent"
    });
  });
});

// get all users as admin user
router.get("/api/v1/admin/users", auth, (req, res) => {
  User.find({}, (err, users) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    return res.status(200).json({
      auth: true,
      message: "Successfully got users",
      users
    });
  });
});

// update a user's password as admin user (generates a new password)
router.put("/api/v1/admin/user/:id/password", auth, (req, res) => {
  const password = short.generate();
  if (!User.validatePassword(password)) {
    return res.status(400).json({ auth: false, message: "Invalid password to update" });
  }
  User.getHashedPassword(password, (err, hash) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    User.findByIdAndUpdate({ _id: req.params.id }, { password: hash }, { new: true }, (err, user) => {
      if (err) {
        return res.status(400).json({ error: true, message: err });
      }
      return res.status(200).json({
        auth: true,
        message: "Successfully updated the password",
        password: password // new unhashed password
      });
    });
  });
});

// update a user's role as admin user
router.put("/api/v1/admin/user/:id/role", auth, (req, res) => {
  const { role } = req.body;
  if (!role) {
    return res.status(400).json({ auth: false, message: "Input role not found" });
  }
  if (!User.validateRole(role)) {
    return res.status(400).json({ auth: false, message: "Invalid role to update" });
  }
  User.findByIdAndUpdate({ _id: req.params.id }, { role }, { new: true }, (err, user) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    return res.status(200).json({
      auth: true,
      message: "Successfully updated the role"
    });
  });
});

// update a user's API key as admin user (generates a new API key)
router.put("/api/v1/admin/user/:id/apikey", auth, (req, res) => {
  const generateApiKey = () => {
    const apiKey = uuidv4();
    User.findOne({ apiKey }, (err, user) => {
      if (err) {
        return res.status(400).json({ error: true, message: err });
      }
      if (user) {
        generateApiKey();
        return;
      }
      User.findByIdAndUpdate({ _id: req.params.id }, { apiKey }, { new: true }, (err, user) => {
        if (err) {
          return res.status(400).json({ error: true, message: err });
        }
        return res.status(200).json({
          auth: true,
          message: "Successfully updated the API key",
          apiKey: user.apiKey // new API key
        });
      });
    });
  }
  generateApiKey();
});

// delete a user by id as admin user
router.delete("/api/v1/admin/user/:id", auth, (req, res) => {
  User.findByIdAndDelete({ _id: req.params.id }, (err, user) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    // delete all projects belong to the user
    Project.deleteMany({ _id: { $in: user.projects } }, (err, result) => {
      if (err) {
        return res.status(400).json({ error: true, message: err });
      }
      return res.status(200).json({
        auth: true,
        message: "Successfully deleted the user"
      });
    });
  });
});

// get all projects as admin user
router.get("/api/v1/admin/projects", auth, (req, res) => {
  Project.find({}, (err, projects) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    return res.status(200).json({
      auth: true,
      message: "Successfully got projects",
      projects
    });
  });
});

// get a project by id as admin user
router.get("/api/v1/admin/project/:id", auth, (req, res) => {
  Project.findById({ _id: req.params.id }, (err, project) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    return res.status(200).json({
      auth: true,
      message: "Successfully got the project",
      project
    });
  });
});

// delete a project by id as admin user
router.delete("/api/v1/admin/project/:id", auth, (req, res) => {
  Project.findByIdAndDelete({ _id: req.params.id }, (err, project) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    return res.status(200).json({
      auth: true,
      message: "Successfully deleted the project"
    });
  });
});

// delete all users and projects
router.put("/api/v1/admin/reset", auth, (req, res) => {
  if (req.user.email !== "admin@viviify.com") {
    return res.status(400).json({ auth: false, message: "Only the main admin is allowed to reset the database" });
  }
  const { secret } = req.body;
  if (!secret) {
    return res.status(400).json({ auth: false, message: "Input secret not found" });
  }
  if (secret !== config.SECRET) {
    return res.status(400).json({ auth: false, message: "Incorrect secret" });
  }
  // delete all users
  User.deleteMany({}, (err, result) => {
    if (err) {
      return res.status(400).json({ error: true, message: err });
    }
    // delete all projects
    Project.deleteMany({}, (err, result) => {
      if (err) {
        return res.status(400).json({ error: true, message: err });
      }
      req.user.deleteToken(req.token, (err, user) => {
        if (err) {
          return res.status(400).json({ error: true, message: err });
        }
        return res.status(200).json({
          auth: true,
          message: "Successfully reset the database"
        });
      });
    });
  });
});

// api not found
router.get("/api/*", (req, res) => {
  return res.status(404).json({ error: true, message: "API not found" });
});

// page not found
router.get("*", (req, res) => {
  return res.render("error.ejs", { status: 404, message: "Page not found" });
});

module.exports = router;