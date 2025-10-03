const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.json());

// 🔴 Replace with your Twilio details
const accountSid = "";
const authToken = "";
const twilioPhone = ""; // Your Twilio number

const client = twilio(accountSid, authToken);

app.post("/send-alert", async (req, res) => {
  try {
    const { to, message } = req.body;
    const result = await client.messages.create({
      body: message,
      from: twilioPhone,
      to: to,
    });
    res.json({ success: true, sid: result.sid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(3000, () => console.log("🚀 Backend running on port 3000"));
