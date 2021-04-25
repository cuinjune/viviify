const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const config = require("./../config/config");
const mongoose = require("mongoose");
const salt = 10;

const userSchema = mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
    unique: 1,
    minlength: 3,
    maxlength: 64
  },
  password: { // hashed password
    type: String,
    required: true,
    trim: true,
    minlength: 8, // used for unhashed password validation
    maxlength: 64 // should be larger than 60 to store bcrypt hash
  },
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 64
  },
  role: {
    type: String,
    default: "basic",
    enum: ["basic", "premium", "admin"]
  },
  apiKey: {
    type: String,
    required: true
  },
  token: {
    type: String
  },
  // required when signup
  signupDate: {
    type: String,
    required: true
  },
  country: {
    type: String,
    default: "unknown"
  },
  region: {
    type: String,
    default: "unknown"
  },
  city: {
    type: String,
    default: "unknown"
  },
  // update when login
  numVisits: {
    type: Number,
    default: 0
  },
  lastLoginDate: {
    type: String
  },
  // update when logout
  timeSpent: {
    type: Number,
    default: 0
  },
  // for later use
  emailConfirmed: {
    type: Boolean,
    default: false
  },
  projects: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "Project",
    default: []
  }]
});

userSchema.pre("save", function (next) {
  const user = this;
  if (user.isModified("password")) {
    bcrypt.genSalt(salt, function (err, salt) {
      if (err) {
        return next(err);
      }
      bcrypt.hash(user.password, salt, function (err, hash) {
        if (err) {
          return next(err);
        }
        user.password = hash;
        next();
      });
    });
  }
  else {
    next();
  }
});

userSchema.methods.comparePassword = function (password, cb) {
  bcrypt.compare(password, this.password, function (err, isMatch) {
    if (err) {
      return cb(err);
    }
    cb(null, isMatch);
  });
}

// generate token
userSchema.methods.generateToken = function (cb) {
  const user = this;
  const token = jwt.sign(user._id.toHexString(), config.SECRET);
  user.token = token;
  user.save(function (err, user) {
    if (err) {
      return cb(err);
    }
    cb(null, user);
  });
}

// delete token
userSchema.methods.deleteToken = function (token, cb) {
  const user = this;
  user.updateOne({ $unset: { token: 1 } }, function (err, user) {
    if (err) {
      return cb(err);
    }
    cb(null, user);
  });
}

// find by token
userSchema.statics.findByToken = function (token, cb) {
  const user = this;
  jwt.verify(token, config.SECRET, function (err, decode) {
    user.findOne({ "_id": decode, "token": token }, function (err, user) {
      if (err) {
        return cb(err);
      }
      cb(null, user);
    });
  });
}

// validate password (used for checking unhashed password)
userSchema.statics.validatePassword = function (password) {
  return typeof password === "string" && password.length >= userSchema.obj.password.minlength && password.length <= userSchema.obj.password.maxlength;
}

// validate name
userSchema.statics.validateName = function (name) {
  return typeof name === "string" && name.length >= userSchema.obj.name.minlength && name.length <= userSchema.obj.name.maxlength;
}

// validate role
userSchema.statics.validateRole = function (role) {
  return typeof role === "string" && userSchema.obj.role.enum.includes(role);
}

// get hashed password
userSchema.statics.getHashedPassword = function (password, cb) {
  bcrypt.genSalt(salt, function (err, salt) {
    if (err) {
      return cb(err);
    }
    bcrypt.hash(password, salt, function (err, hash) {
      if (err) {
        return cb(err);
      }
      cb(null, hash);
    });
  });
}

module.exports = mongoose.model("User", userSchema);