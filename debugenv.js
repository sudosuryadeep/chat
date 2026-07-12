const path = require("path");
const result = require("dotenv").config({
  path: path.join(__dirname, ".env"),
  debug: true,
});

console.log("---------------------------------");
console.log("dotenv parse error:", result.error);
console.log("MONGODB_URI:", process.env.MONGODB_URI);
console.log("CLOUDINARY_CLOUD_NAME:", process.env.CLOUDINARY_CLOUD_NAME);
console.log("---------------------------------");
