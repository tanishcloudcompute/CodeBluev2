const express = require('express');
const bodyParser = require('body-parser');
const twilio = require("twilio");
const path = require('path');
const admin = require('firebase-admin');
require('dotenv').config();

// Initialize Firebase Admin
admin.initializeApp({
  projectId: 'burnished-inn-454113-g0'
});

const db = admin.firestore();

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: false }));

const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH;

// Add service status tracking
let serviceStatus = {
  server: 'healthy',
  twilio: 'unknown',
  lastChecked: new Date().toISOString()
};

// Function to check Twilio service status
async function checkTwilioStatus() {
  try {
    await client.api.accounts(accountSid).fetch();
    serviceStatus.twilio = 'healthy';
  } catch (error) {
    serviceStatus.twilio = 'error';
    console.error('Twilio service error:', error);
  }
  serviceStatus.lastChecked = new Date().toISOString();
}

const client = twilio(accountSid, authToken);
const VoiceResponse = twilio.twiml.VoiceResponse;

// Initial Twilio status check
checkTwilioStatus();

// Periodic Twilio status check every 60 seconds
setInterval(checkTwilioStatus, 60000);

let callStatus = [];

// Function to log messages to Firestore
async function logToFile(phone, message) {
  const logMessage = {
    timestamp: new Date().toISOString(),
    phone,
    message
  };
  
  try {
    await db.collection('call_logs').add(logMessage);
  } catch (err) {
    console.error('Error writing to log:', err);
  }
}

// Function to create a call
async function createCall(sender) {
  await logToFile(sender, 'Request received: ' + sender);
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    numDigits: 1,
    action: `${process.env.HOST_IP}/processResponse`,
    method: 'POST'
  });

  gather.say(
    'Attention: Code Blue. This is an emergency alert from BITS Goa Medical Center. If you are available to respond immediately, please press 1; if not, press 2.',
    { voice: 'alice' }
  );

  twiml.redirect(
    `${process.env.HOST_IP}/notanswered`
  );

  try {
    const call = await client.calls.create({
      from: "+18313221097",
      to: sender,
      twiml: twiml.toString(),
    });

    callStatus.push({ phone: sender, status: 'In Progress', sid: call.sid });
    await logToFile(sender, `Call created successfully. SID: ${call.sid}`);
    return { message: 'Call has been created successfully.', sid: call.sid };
  } catch (error) {
    await logToFile(sender, 'Error creating call: ' + error.message);
    throw new Error('Error creating call: ' + error.message);
  }
}

app.post('/hotline', async (req, res) => {
  // Clear callStatus array
  callStatus = [];
  
  try {
    // Get current call status and move to history
    const callStatusSnapshot = await db.collection('call_status').get();
    const callStatusData = [];
    callStatusSnapshot.forEach(doc => {
      callStatusData.push(doc.data());
    });

    // Add to history
    const batch = db.batch();
    for (const callData of callStatusData) {
      const historyRef = db.collection('hotline_history').doc();
      batch.set(historyRef, callData);
    }
    await batch.commit();

    // Clear call_status collection
    const deletePromises = callStatusSnapshot.docs.map(doc => doc.ref.delete());
    await Promise.all(deletePromises);

    // Get members and initiate calls
    const membersSnapshot = await db.collection('members').get();
    const members = [];
    membersSnapshot.forEach(doc => {
      members.push(doc.data());
    });

    for (const member of members) {
      try {
        await createCall(member.phone);
      } catch (error) {
        console.error('Error creating call:', error);
      }
    }

    res.status(200).send("Hotline calls initiated.");
  } catch (error) {
    console.error('Error in hotline endpoint:', error);
    res.status(500).send({ message: 'Error processing hotline request', error: error.message });
  }
});

app.post('/processResponse', async (req, res) => {
  const digit = req.body.Digits;
  const response = new VoiceResponse();
  const sid = req.body.CallSid;
  console.log('Received input:', digit);
  const call = callStatus.find(call => call.sid === sid);
  const sender = call ? call.phone : 'unknown';
  await logToFile(sender, 'Received input: ' + digit);
  
  if (digit === '1') {
    console.log('Emergency call accepted.');
    await logToFile(sender, 'Emergency call accepted.');
    response.say('Emergency call accepted. Goodbye.');
    const call = callStatus.find(call => call.sid === sid);
    if (call) {
      call.status = 'Accepted';
    }
  } else if (digit === '2') {
    console.log('Emergency call declined.');
    await logToFile(sender, 'Emergency call declined.');
    response.say('Emergency call declined. Goodbye.');
    const call = callStatus.find(call => call.sid === sid);
    if (call) {
      call.status = 'Declined';
    }
  } else {
    console.log('Invalid input.');
    await logToFile(sender, 'Invalid input.');
    response.say('Invalid input. Goodbye.');
    const call = callStatus.find(call => call.sid === sid);
    if (call) {
      call.status = 'Invalid';
    }
  }
  response.hangup();
  res.type('text/xml');
  res.send(response.toString());
});

app.post('/notanswered', async (req, res) => {
  const sid = req.body.CallSid;
  console.log('SID:', sid);
  const call = callStatus.find(call => call.sid === sid);
  const sender = call ? call.phone : 'unknown';
  await logToFile(sender, 'No response received for SID: ' + sid);
  if (call) {
    call.status = 'No Response';
  }
  console.log('No response received.');
  res.send('No response received.');
});

// Function to update call status in Firestore
async function updateCallStatusFile() {
  try {
    const batch = db.batch();
    
    // Clear existing call status
    const existingDocs = await db.collection('call_status').get();
    existingDocs.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Add new call status
    callStatus.forEach(status => {
      const docRef = db.collection('call_status').doc();
      batch.set(docRef, status);
    });

    await batch.commit();
  } catch (error) {
    console.error('Error updating call status:', error);
  }
}

app.get('/callReport', async (_, res) => {
  try {
    await updateCallStatusFile();
    
    const [callStatusDocs, membersDocs] = await Promise.all([
      db.collection('call_status').get(),
      db.collection('members').get()
    ]);

    const callStatus = [];
    callStatusDocs.forEach(doc => {
      callStatus.push(doc.data());
    });

    const members = [];
    membersDocs.forEach(doc => {
      members.push(doc.data());
    });

    const report = callStatus.map(call => {
      const member = members.find(member => member.phone === call.phone);
      return {
        ...call,
        name: member ? member.name : 'Unknown'
      };
    });
    
    res.status(200).send(report);
  } catch (error) {
    res.status(500).send({ message: 'Error generating report', error: error.message });
  }
});

app.post('/removeMember', async (req, res) => {
  console.log('Request received:', req.body);
  const { phone } = req.body;

  try {
    const memberQuery = await db.collection('members').where('phone', '==', phone).get();
    
    if (memberQuery.empty) {
      return res.status(404).send({ message: 'Member not found' });
    }

    await memberQuery.docs[0].ref.delete();
    res.status(200).send({ message: 'Member removed successfully' });
  } catch (error) {
    res.status(500).send({ message: 'Error removing member', error: error.message });
  }
});

app.post('/addMember', async (req, res) => {
  console.log('Request received:', req.body);
  const { name, phone } = req.body;
  const newMember = { name, phone };

  try {
    await db.collection('members').add(newMember);
    res.status(200).send({ message: 'Member added successfully' });
  } catch (error) {
    res.status(500).send({ message: 'Error adding member', error: error.message });
  }
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Service status endpoint
app.get('/service-status', (req, res) => {
  res.status(200).json(serviceStatus);
});

app.listen(3001, () => {
  console.log('Server is running on port 3001');
});