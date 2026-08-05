import nodemailer from 'nodemailer';

// REPLACE THESE WITH YOUR EXACT DETAILS
const EMAIL = 'YOUR_REAL_EMAIL@gmail.com'; 
const APP_PASSWORD = 'abcd efgh ijkl mnop'; // The 16-char code

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'fzhang618@gmail.com',
        pass: 'uqtl xmco pfnz ewzc'
    }
});

async function verify() {
    try {
        console.log("1. Attempting to connect to Gmail...");
        await transporter.verify();
        console.log("✅ SUCCESS! Your credentials are correct.");
    } catch (error) {
        console.error("❌ ERROR: Connection failed.");
        console.error("------------------------------------------------");
        console.error(error);
        console.error("------------------------------------------------");
        console.log("TROUBLESHOOTING:");
        console.log("1. Did you restart the server after saving?");
        console.log("2. Does the 'user' email match the App Password account exactly?");
        console.log("3. Are there hidden spaces in your password string?");
    }
}

verify();