import { Router } from 'express';
import auth from './auth.js';
import tenants from './tenants.js';
import users from './users.js';
import conversations from './conversations.js';
import compiler from './compiler.js';
import { compilerWebhookHandler } from './compiler.js';
import training from './training.js';
import modules from './modules.js';
import endpoints from './endpoints.js';
import apikeys from './apikeys.js';
import embed from './embed.js';
import dashboard from './dashboard.js';
import usage from './usage.js';
import contacts from './contacts.js';
import cloud from './cloud.js';
import calendars from './calendars.js';
import email from './email.js';
import collectFields from './collectFields.js';
import documents from './documents.js';
import tasks from './tasks.js';
import phone from './phone.js';
import whatsappChat from './whatsapp-chat.js';
import gemini from './gemini.js';
import trainingDocs from './training-docs.js';
import trainingChat from './training-chat.js';
import flows from './flows.js';
import externalChats from './external-chats.js';
import me from './me.js';
import sip from './sip.js';
import agents from './agents.js';
import db from './db.js';
import { whatsappWebhookRouter, whatsappSetupRouter } from './whatsapp.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ ok: true, service: 'sophia', ts: Date.now() }));

router.use('/auth', auth);
router.use('/tenants', tenants);
router.use('/users', users);
router.use('/conversations', conversations);
router.use('/training', training);
router.use('/modules', modules);
router.use('/endpoints', endpoints);
router.use('/apikeys', apikeys);
router.use('/embed', embed);
router.use('/dashboard', dashboard);
router.use('/usage', usage);
router.use('/contacts', contacts);
router.use('/cloud', cloud);
router.use('/calendars', calendars);
router.use('/email', email);
router.use('/collect-fields', collectFields);
router.use('/documents', documents);
router.use('/tasks', tasks);

// Nuove rotte
router.use('/phone', phone);
router.use('/whatsapp-chat', whatsappChat);
router.use('/gemini', gemini);
router.use('/training-docs', trainingDocs);
router.use('/training-chat', trainingChat);
router.use('/flows', flows);
router.use('/external-chats', externalChats);
router.use('/me', me);
router.use('/sip', sip);
router.use('/agents', agents);
router.use('/db', db);

// PHI Compiler webhook — PUBBLICO, nessuna auth, prima di tutto il resto
router.post('/compiler/webhook/:tenantId', compilerWebhookHandler);
router.get('/compiler/webhook/:tenantId/test', (req, res) => res.json({ ok: true, tenantId: req.params.tenantId }));

// WhatsApp: webhook pubblico (nessuna auth) + setup wizard (autenticato)
router.use('/whatsapp', whatsappWebhookRouter);
router.use('/modules/whatsapp/setup', whatsappSetupRouter);

// PHI Compiler: route autenticate
router.use('/compiler', compiler);

export default router;
