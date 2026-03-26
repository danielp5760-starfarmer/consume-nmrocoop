require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const cloudinary = require('cloudinary').v2;
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── Cloudinary 설정 ─────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── 파일 업로드 (메모리 저장) ───────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  }
});

// ── API 클라이언트 초기화 ───────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion    = new Client({ auth: process.env.NOTION_API_KEY });
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;

// ── Cloudinary 업로드 함수 ──────────────────────────────────
async function uploadToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: '영수증', resource_type: 'image' },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    );
    stream.end(file.buffer);
  });
}

// ============================================================
// 1. 영수증 AI 분석 API
// POST /api/analyze-receipt
// ============================================================
app.post('/api/analyze-receipt', upload.array('receipts', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '영수증 이미지가 없습니다.' });
    }

    const file = req.files[0];
    const base64Image = file.buffer.toString('base64');

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: file.mimetype, data: base64Image },
          },
          {
            type: 'text',
            text: `이 영수증 이미지를 분석해서 아래 JSON 형식으로만 답하세요.
다른 텍스트는 절대 포함하지 마세요.

{
  "items": [
    { "name": "품목명", "qty": 수량, "unit_price": 단가, "price": 소계 }
  ],
  "subtotal": 소계합계,
  "tax": 세금(없으면 0),
  "total": 최종합계
}

- 금액은 숫자만 (원화 기준, 쉼표 없이)
- 영수증이 불명확하면 읽을 수 있는 항목만 포함
- qty나 단가가 명시 안 되면 qty:1, unit_price를 price와 동일하게`,
          },
        ],
      }],
    });

    const rawText = message.content[0].text.trim();
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed  = JSON.parse(cleaned);
    return res.json(parsed);

  } catch (err) {
    console.error('[analyze-receipt]', err);
    return res.status(500).json({ error: '영수증 분석 중 오류가 발생했습니다.' });
  }
});

// ============================================================
// 2. 지출 내역 제출 + Cloudinary 업로드 + 노션 저장
// POST /api/submit-expense
// ============================================================
app.post('/api/submit-expense', upload.array('receipts', 10), async (req, res) => {
  try {
    const {
      date, submitter, department, event,
      category, amount, paymentMethod, notes,
    } = req.body;

    const totalAmount = parseInt(amount, 10) || 0;

    // ── Cloudinary에 영수증 이미지 업로드 ───────────────────
    let imageUrls = [];
    if (req.files && req.files.length > 0) {
      try {
        imageUrls = await Promise.all(req.files.map(uploadToCloudinary));
        console.log('Cloudinary 업로드 완료:', imageUrls);
      } catch (uploadErr) {
        console.warn('[Cloudinary 업로드 실패]', uploadErr.message);
      }
    }

    // ── 노션 페이지 생성 ────────────────────────────────────
    const notionResponse = await notion.pages.create({
      parent: { database_id: NOTION_DB_ID },
      properties: {
        '행사': {
          title: [{ text: { content: event || '(미입력)' } }],
        },
        '날짜': {
          date: { start: date },
        },
        '지출자': {
          rich_text: [{ text: { content: submitter || '' } }],
        },
        '부서': {
          select: { name: department || '기타' },
        },
        '지출유형': {
          select: { name: category || '기타' },
        },
        '총금액': {
          number: totalAmount,
        },
        '결제수단': {
          select: { name: paymentMethod || '기타' },
        },
        '품목내역': {
          rich_text: [{ text: { content: imageUrls.length > 0 ? '영수증 첨부됨' : '영수증 없음' } }],
        },
        '비고': {
          rich_text: [{ text: { content: notes || '' } }],
        },
        '상태': {
          select: { name: '검토 중' },
        },
      },
    });

    // ── 노션 페이지 본문에 영수증 이미지 첨부 ───────────────
    if (imageUrls.length > 0) {
      const imageBlocks = imageUrls.map(url => ({
        object: 'block',
        type: 'image',
        image: {
          type: 'external',
          external: { url },
        },
      }));

      await notion.blocks.children.append({
        block_id: notionResponse.id,
        children: [
          {
            object: 'block',
            type: 'heading_3',
            heading_3: { rich_text: [{ text: { content: '🧾 영수증' } }] },
          },
          ...imageBlocks,
        ],
      });
    }

    return res.json({
      success: true,
      notionPageId: notionResponse.id,
      notionUrl: notionResponse.url,
      imageUrls,
      message: '노션에 성공적으로 저장되었습니다.',
    });

  } catch (err) {
    console.error('[submit-expense]', err);
    return res.status(500).json({ error: '제출 중 오류가 발생했습니다.', detail: err.message });
  }
});

// ── 서버 시작 ───────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`\n🚀 서버 실행 중: http://localhost:${PORT}`);
  console.log(`   Claude API:  ${process.env.ANTHROPIC_API_KEY      ? '✓ 연결됨' : '✗ 없음'}`);
  console.log(`   Notion API:  ${process.env.NOTION_API_KEY         ? '✓ 연결됨' : '✗ 없음'}`);
  console.log(`   Notion DB:   ${process.env.NOTION_DATABASE_ID     ? '✓ 설정됨' : '✗ 없음'}`);
  console.log(`   Cloudinary:  ${process.env.CLOUDINARY_CLOUD_NAME  ? '✓ 연결됨' : '✗ 없음'}`);
});
