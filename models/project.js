const mongoose = require("mongoose");
const config = require("./../config/config");
const ASCIIFolder = require("fold-to-ascii/lib/ascii-folder");
const AWS = require("aws-sdk");
const Stream = require("stream");
const path = require("path");
const fs = require("fs");
const mp3Duration = require("mp3-duration");

const projectSchema = mongoose.Schema({
  text: {
    type: String,
    default: "",
    minlength: 0,
    maxlength: 12000
  },
  voice: {
    type: String,
    default: "joanna",
    enum: ["off", "joanna", "salli", "ivy", "matthew", "joey", "justin"]
  },
  speed: {
    type: String,
    default: "medium",
    enum: ["slower", "slow", "medium", "fast", "faster"]
  },
  subtitle: {
    type: String,
    default: "medium",
    enum: ["off", "tiny", "small", "medium", "large", "huge"]
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  urlKey: {
    type: String,
    required: true
  },
  createdDate: {
    type: String,
    required: true
  },
  lastModifiedDate: {
    type: String,
    required: true
  },
  keywords: [{
    type: String,
    default: []
  }],
  segments: [{
    type: { type: String },
    start: { type: Number },
    end: { type: Number },
    text: { type: String },
    url: { type: String },
    videos: [{
      url: { type: String },
      id: { type: String }
    }],
    videoIndex: { type: Number }
  }]
});

// get segments
projectSchema.methods.getSegments = function (updatedData, cb) {
  const project = this;
  if (!updatedData.text.length) {
    updatedData.segments = [];
    return cb(null, updatedData);
  }

  const polly = new AWS.Polly({
    signatureVersion: "v4",
    region: config.AWS_REGION,
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY
  });

  let voice = updatedData.voice;
  if (voice === "off") {
    voice = "Joanna";
  }
  else {
    voice = voice[0].toUpperCase() + voice.slice(1);
  }

  let speed = updatedData.speed;
  if (speed === "slower") {
    speed = "x-slow";
  }
  else if (speed === "faster") {
    speed = "x-fast";
  }

  const splittedTexts = updatedData.text.match(/[^?.!]{1,3000}(?:\?|.|!)/g).map(str => str.trim());
  updatedData.segments = [];
  let previousVideoLength = 0;

  // this function will be called recursively until it processes all splitted texts
  const requestToPolly = (index) => {
    const params = {
      Text: `<speak><prosody rate="${speed}">${splittedTexts[index]}</prosody></speak>`,
      TextType: "ssml",
      VoiceId: voice,
      OutputFormat: "mp3"
    }
    polly.synthesizeSpeech(params, (err, data) => {
      if (err) {
        return cb(err);
      }
      if (!data || !(data.AudioStream instanceof Buffer)) {
        return cb("Failed to retrieve the speech data");
      }
      const filename = path.join(process.cwd(), "temp", `speech-${project.urlKey}-${new Date().toISOString()}.mp3`);
      const writeStream = fs.createWriteStream(filename);
      const bufferStream = new Stream.PassThrough();
      bufferStream.end(data.AudioStream);
      bufferStream.pipe(writeStream);
      writeStream.on("finish", () => {
        fs.readFile(filename, (err, file) => {
          if (err) {
            return cb(err);
          }
          mp3Duration(filename, (err, duration) => {
            if (err) {
              return cb(err);
            }
            fs.unlink(filename, (err) => {
              if (err) {
                return cb(err);
              }
              const base64File = Buffer.from(file, "binary").toString("base64");
              const audio = `data:audio/mp3;base64,${base64File}`;
              params.OutputFormat = "json";
              params.SpeechMarkTypes = ["word", "sentence"];
              polly.synthesizeSpeech(params, (err, data) => {
                if (err) {
                  return cb(err);
                }
                if (!data || !(data.AudioStream instanceof Buffer)) {
                  return cb("Failed to retrieve the speech data");
                }
                const buf = Buffer.from(data.AudioStream);
                const lines = buf.toString().split("\n");
                const marks = [];
                for (const line of lines) {
                  if (line) {
                    const parsed = JSON.parse(line);
                    marks.push(parsed);
                  }
                }
                const videoLength = Math.floor(duration * 1000);

                // add speech audio
                const segment = {
                  type: "audio",
                  start: 0 + previousVideoLength,
                  end: videoLength + previousVideoLength,
                  text: "",
                  url: audio,
                  videos: [],
                  videoIndex: 0
                };
                updatedData.segments.push(segment);

                // add video and subtitle segments
                const getMaxNumWordsPerSubtitle = () => {
                  switch (updatedData.subtitle) {
                    case "off": return 8 * 4;
                    case "tiny": return 7 * 4;
                    case "small": return 6 * 4;
                    case "medium": return 5 * 4;
                    case "large": return 4 * 4;
                    case "huge": return 3 * 4;
                    default: return 5 * 4;
                  }
                }
                // maximum number of words used per subtitle
                const maxNumWordsPerSubtitle = getMaxNumWordsPerSubtitle();

                const getDistributedArray = (n, max) => {
                  let a = [];
                  let r = n;
                  let c = Math.ceil(n / max);
                  let i = 0;
                  while (r > 0) {
                    let t = Math.ceil(r / c);
                    a[i++] = t;
                    r -= t;
                    c--;
                  }
                  return a;
                }

                for (let i = 0; i < marks.length; i++) {
                  const mark = marks[i];
                  if (mark.type === "sentence") {
                    const type = "subtitle";
                    const text = mark.value;
                    const start = mark.time;
                    let end = 0;
                    const words = [];
                    for (i++; i < marks.length; i++) {
                      const mark = marks[i];
                      if (mark.type === "word") {
                        words.push(mark);
                      }
                      else if (mark.type === "sentence") {
                        end = mark.time;
                        i--;
                        break;
                      }
                    }
                    if (!end) {
                      end = videoLength;
                    }
                    // add video segment
                    const segment = {
                      type: "video",
                      start: start + previousVideoLength,
                      end: end + previousVideoLength,
                      text: text,
                      url: "",
                      videos: [],
                      videoIndex: 0
                    };
                    updatedData.segments.push(segment);

                    // if the subtitle is too long, split them evenly
                    if (words.length > maxNumWordsPerSubtitle) {
                      const arr = getDistributedArray(words.length, maxNumWordsPerSubtitle);
                      let startWordIndex = 0;
                      for (let i = 0; i < arr.length; i++) {
                        const endWordIndex = startWordIndex + arr[i];
                        const startWord = words[startWordIndex];
                        const startTime = startWordIndex ? startWord.time : start;
                        const startSubtitleIndex = startWord.start - mark.start;
                        let endTime = 0;
                        let newText = "";
                        if (endWordIndex < words.length) {
                          const endWord = words[endWordIndex]; // this is actually next to the end word
                          endTime = endWord.time;
                          const endSubtitleIndex = endWord.start - mark.start;
                          newText = text.substring(startSubtitleIndex, endSubtitleIndex - 1);
                        }
                        else {
                          endTime = end;
                          newText = text.substring(startSubtitleIndex);
                        }
                        // add subtitle segment
                        const segment = {
                          type: type,
                          start: startTime + previousVideoLength,
                          end: endTime + previousVideoLength,
                          text: newText,
                          url: "",
                          videos: [],
                          videoIndex: 0
                        }
                        updatedData.segments.push(segment);
                        startWordIndex = endWordIndex;
                      }
                    }
                    else {
                      // add subtitle segment
                      const segment = {
                        type: type,
                        start: start + previousVideoLength,
                        end: end + previousVideoLength,
                        text: text,
                        url: "",
                        videos: [],
                        videoIndex: 0
                      }
                      updatedData.segments.push(segment);
                    }
                  }
                }
                previousVideoLength += videoLength;
                if (index + 1 === splittedTexts.length) {
                  return cb(null, updatedData);
                }
                requestToPolly(index + 1);
              });
            });
          });
        });
      });
    });
  }
  requestToPolly(0);
}

// get valid text
projectSchema.statics.getValidText = function (text) {
  let newText = text.trim();
  if (!newText.length) {
    return newText;
  }
  if (/[[\]]/.test(newText)) {
    // remove all square brackets including the text inside
    newText = newText.replace(/(\[.*?\])/g, "").replace(/[[\]]/g, "").trim();
  }
  if (/[{}]/.test(newText)) {
    // remove all curly brackets including the text inside
    newText = newText.replace(/({.*?})/g, "").replace(/[{}]/g, "").trim();
  }
  if (/[<>]/.test(newText)) {
    // remove all angle brackets including the text inside
    newText = newText.replace(/(<.*?>)/g, "").replace(/[<>]/g, "").trim();
  }
  if (/&/.test(newText)) {
    // replace all '&' with 'and'
    newText = newText.replace(/\s&\s|&/g, " and ").trim();
  }
  if (/[^\x20-\x7E]/.test(newText)) {
    // replace all non-ascii characters to the closest ascii characters
    newText = ASCIIFolder.foldReplacing(newText).replace(/\0/g, "").trim();
  }
  return newText;
}

// validate voice
projectSchema.statics.validateVoice = function (voice) {
  return typeof voice === "string" && projectSchema.obj.voice.enum.includes(voice);
}

// validate speed
projectSchema.statics.validateSpeed = function (speed) {
  return typeof speed === "string" && projectSchema.obj.speed.enum.includes(speed);
}

// validate subtitle
projectSchema.statics.validateSubtitle = function (subtitle) {
  return typeof subtitle === "string" && projectSchema.obj.subtitle.enum.includes(subtitle);
}

module.exports = mongoose.model("Project", projectSchema);