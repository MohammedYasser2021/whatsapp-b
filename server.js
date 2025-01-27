const express = require('express');
const cors = require('cors');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');

const app = express();

// Setup multer for file storage with better error handling
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = 'uploads';
        try {
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            cb(null, uploadDir);
        } catch (error) {
            cb(new Error('Could not create upload directory'));
        }
    },
    filename: function (req, file, cb) {
        // Sanitize filename and add timestamp
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        const safeName = `${timestamp}${ext}`.replace(/[^a-zA-Z0-9.-]/g, '');
        cb(null, safeName);
    }
});

// Configure multer with file size limits and file type validation
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 16 * 1024 * 1024, // 16MB max file size for WhatsApp
    },
    fileFilter: (req, file, cb) => {
        console.log('Received file:', {
            originalname: file.originalname,
            mimetype: file.mimetype
        });

        // Accept images, videos, and audio files
        const allowedMimes = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'video/mp4',
            'video/mpeg',
            'video/quicktime',
            'video/webm',
            'audio/mpeg',
            'audio/wav',
            'audio/ogg',
            'audio/webm',
            'audio/mp4',
            'audio/aac',
            'audio/x-m4a',
            'application/ogg'
        ];

        if (allowedMimes.includes(file.mimetype) || file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            console.log('Rejected file type:', file.mimetype);
            cb(new Error(`نوع الملف غير مدعوم: ${file.mimetype}`));
        }
    }
});

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
    optionsSuccessStatus: 200
  }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));
app.use('/uploads', express.static('uploads'));


  

let client;
let connectionStatus = 'disconnected';
let qrCodeData = null;

async function destroyClient() {
    connectionStatus = 'disconnecting';
    if (client) {
        try {
            await client.destroy();
            client = null;
        } catch (error) {
            console.error('Error destroying client:', error);
        }
    }
    connectionStatus = 'disconnected';
    qrCodeData = null;
}

async function clearAuthData() {
    try {
        const authDir = path.join(process.cwd(), '.wwebjs_auth');
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }
    } catch (error) {
        console.error('Error clearing auth data:', error);
    }
}

function initializeWhatsApp() {
    connectionStatus = 'initializing';
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', (qr) => {
        connectionStatus = 'waiting-for-qr';
        qrCodeData = qr;
        qrcode.generate(qr, { small: true });
        console.log('QR Code generated! Scan with WhatsApp');
    });

    client.on('loading_screen', (percent, message) => {
        connectionStatus = `connecting:${percent}`;
        console.log('Loading:', percent, '%', message);
    });

    client.on('ready', () => {
        connectionStatus = 'connected';
        qrCodeData = null;
        console.log('WhatsApp client is ready!');
    });

    client.on('authenticated', () => {
        connectionStatus = 'authenticating';
        console.log('WhatsApp authenticated successfully!');
    });

    client.on('auth_failure', (msg) => {
        console.error('Authentication failed:', msg);
        connectionStatus = 'disconnected';
    });

    client.on('disconnected', async () => {
        console.log('WhatsApp disconnected!');
        await destroyClient();
        await clearAuthData();
        initializeWhatsApp();
    });

    try {
        client.initialize().catch(error => {
            console.error('Error during initialization:', error);
            connectionStatus = 'disconnected';
        });
    } catch (error) {
        console.error('Error initializing client:', error);
        connectionStatus = 'disconnected';
    }
}

// Initialize WhatsApp client
initializeWhatsApp();

// Routes
app.get('/status', (req, res) => {
    res.json({ 
        status: connectionStatus,
        qrCode: qrCodeData
    });
});

app.post('/disconnect', async (req, res) => {
    try {
        await destroyClient();
        await clearAuthData();
        connectionStatus = 'initializing';
        initializeWhatsApp();
        
        res.json({ 
            success: true, 
            message: 'Disconnected successfully',
            status: connectionStatus
        });
    } catch (error) {
        console.error('Error during disconnect:', error);
        connectionStatus = 'initializing';
        qrCodeData = null;
        initializeWhatsApp();
        
        res.json({ 
            success: true, 
            message: 'Disconnected with recovery',
            status: connectionStatus
        });
    }
});

app.post('/send-bulk-messages', async (req, res) => {
    try {
        const { numbers, message, mediaPaths } = req.body;
        console.log('Received request:', { numbers, message, mediaPaths });

        if (!client) {
            return res.status(400).json({ error: 'WhatsApp client not initialized' });
        }

        if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
            return res.status(400).json({ error: 'يجب توفير قائمة صالحة من الأرقام' });
        }

        const results = { success: [], failed: [] };

        for (const number of numbers) {
            try {
                let formattedNumber = number.toString().replace(/\D/g, '');
                if (!formattedNumber.startsWith('20')) {
                    formattedNumber = '20' + formattedNumber;
                }
                const chatId = `${formattedNumber}@c.us`;

                console.log(`Processing number: ${formattedNumber}`);

                const isRegistered = await client.isRegisteredUser(chatId);
                if (!isRegistered) {
                    throw new Error('رقم غير مسجل في واتساب');
                }

                if (mediaPaths && mediaPaths.length > 0) {
                    for (const mediaPath of mediaPaths) {
                        try {
                            const fullPath = path.join(process.cwd(), mediaPath);
                            console.log('Processing media file:', {
                                path: fullPath,
                                exists: fs.existsSync(fullPath)
                            });
                            
                            if (!fs.existsSync(fullPath)) {
                                throw new Error('ملف الوسائط غير موجود');
                            }

                            const mimeType = mime.lookup(fullPath);
                            if (!mimeType) {
                                throw new Error('نوع الملف غير مدعوم');
                            }
                            console.log('Detected MIME type:', mimeType);

                            const fileStats = fs.statSync(fullPath);
                            if (fileStats.size > 16 * 1024 * 1024) {
                                throw new Error('حجم الملف كبير جداً. الحد الأقصى هو 16 ميجابايت');
                            }

                            console.log('File stats:', {
                                size: fileStats.size,
                                created: fileStats.birthtime,
                                modified: fileStats.mtime
                            });

                            // Read file in chunks for better memory management
                            const base64Data = await new Promise((resolve, reject) => {
                                const chunks = [];
                                const stream = fs.createReadStream(fullPath);
                                stream.on('data', chunk => chunks.push(chunk));
                                stream.on('end', () => {
                                    const buffer = Buffer.concat(chunks);
                                    resolve(buffer.toString('base64'));
                                });
                                stream.on('error', reject);
                            });

                            console.log('File read successfully, base64 length:', base64Data.length);

                            const media = new MessageMedia(
                                mimeType,
                                base64Data,
                                path.basename(fullPath)
                            );

                            // Send the media message with a delay
                            await new Promise(resolve => setTimeout(resolve, 1000)); // Add delay between messages
                            await client.sendMessage(chatId, media, {
                                sendMediaAsDocument: mimeType.startsWith('video/'),
                                caption: message
                            });

                            console.log('Media sent successfully');

                        } catch (mediaError) {
                            console.error('Detailed media error:', {
                                message: mediaError.message,
                                stack: mediaError.stack,
                                mediaPath
                            });
                            throw new Error(`فشل في إرسال الوسائط: ${mediaError.message}`);
                        }
                    }
                } else if (message) {
                    await client.sendMessage(chatId, message);
                } else {
                    throw new Error('يجب توفير رسالة أو ملف وسائط');
                }

                results.success.push(formattedNumber);
                console.log('✅ Message sent to:', formattedNumber);

            } catch (error) {
                console.error('Error processing number:', {
                    number,
                    error: error.message,
                    stack: error.stack
                });

                results.failed.push({
                    number,
                    reason: error.message
                });
                console.log('❌ Failed for:', number, error.message);
            }
        }

        res.json({ results });

    } catch (error) {
        console.error('Main error:', error);
        res.status(500).json({ error: 'خطأ في معالجة الطلب: ' + error.message });
    }
});

app.post('/upload-media', (req, res) => {
    upload.single('media')(req, res, function(err) {
        if (err instanceof multer.MulterError) {
            console.error('Multer error:', err);
            return res.status(400).json({ 
                error: 'خطأ في رفع الملف',
                details: err.message 
            });
        } else if (err) {
            console.error('Upload error:', err);
            return res.status(400).json({ 
                error: 'خطأ في رفع الملف',
                details: err.message 
            });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'لم يتم اختيار ملف' });
        }

        console.log('File uploaded successfully:', {
            filename: req.file.filename,
            mimetype: req.file.mimetype,
            size: req.file.size,
            path: req.file.path
        });

        res.json({ 
            success: true,
            filePath: req.file.path,
            fileName: req.file.filename,
            mimeType: req.file.mimetype
        });
    });
});
// Add a basic health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });



  // Add root route
app.get('/', (req, res) => {
    res.json({ 
      status: 'Server is running',
      endpoints: {
        status: '/status',
        disconnect: '/disconnect',
        sendBulkMessages: '/send-bulk-messages',
        uploadMedia: '/upload-media',
        health: '/health'
      }
    });
  });


  const PORT = process.env.PORT || 3001;
  const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
  });
  
  server.keepAliveTimeout = 120 * 1000;
  server.headersTimeout = 120 * 1000;
  