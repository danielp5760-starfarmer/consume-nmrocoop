// ============================================================
// server.js — 지출 내역 제출 백엔드
// Node.js (Express) + Claude API + Notion API
// ============================================================
// 설치: npm install express multer @anthropic-ai/sdk @notionhq/client cors dotenv
// 실행: node server.js
// ============================================================

require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { Client } = require('@notionhq/client');

const app = express();
app.use(cors());
app.use(express.json());

// ── 파일 업로드 (메모리 저장) ──────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  }
});

// ── API 클라이언트 초기화 ──────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
});

const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;

// ============================================================
// 1. 영수증 AI 분석 API
// POST /api/analyze-receipt
// ============================================================
app.post('/api/analyze-receipt', upload.array('receipts', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '영수증 이미지가 없습니다.' });
    }

    // 첫 번째 영수증 이미지를 분석 (여러 장이면 모두 합산도 가능)
    const file = req.files[0];
    const base64Image = file.buffer.toString('base64');
    const mediaType = file.mimetype; // 'image/jpeg' | 'image/png' 등

    // Claude Vision API 호출
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Image,
              },
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
        },
      ],
    });

    // JSON 파싱
    const rawText = message.content[0].text.trim();
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return res.json(parsed);
  } catch (err) {
    console.error('[analyze-receipt]', err);
    return res.status(500).json({ error: '영수증 분석 중 오류가 발생했습니다.' });
  }
});


// ============================================================
// 2. 지출 내역 제출 + 노션 DB 저장 API
// POST /api/submit-expense
// ============================================================
app.post('/api/submit-expense', upload.array('receipts', 10), async (req, res) => {
  try {
    const {
      date,           // "2024-03-15"
      submitter,      // "홍길동"
      department,     // "개발팀"
      event,          // "팀 회식"
      category,       // "식비"
      amount,         // "55000"
      paymentMethod,  // "법인카드"
      notes,          // "비고"
    } = req.body;

    // ── 영수증 재분석 (이미지가 있는 경우) ──────────────────
    let analysisResult = null;
    if (req.files && req.files.length > 0) {
      try {
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
                text: `영수증을 분석해서 JSON만 반환하세요:
{"items":[{"name":"품목","qty":1,"unit_price":0,"price":0}],"total":0}`,
              },
            ],
          }],
        });

        const cleaned = message.content[0].text.trim().replace(/```json|```/g, '');
        analysisResult = JSON.parse(cleaned);
      } catch (aiErr) {
        console.warn('[AI 분석 실패, 수동 금액 사용]', aiErr.message);
      }
    }

    // ── 노션 페이지 생성 ────────────────────────────────────
    const items = analysisResult?.items || [];
    const totalAmount = parseInt(amount, 10) || analysisResult?.total || 0;

    // 품목 목록을 노션 rich_text 형태로 변환
    const itemsText = items.length > 0
      ? items.map(i => `${i.name} ×${i.qty} = ₩${i.price.toLocaleString()}`).join('\n')
      : '(영수증 미첨부)';

    // 노션 DB에 페이지 생성
    // ⚠️ 아래 properties의 키 이름은 실제 노션 DB 컬럼명과 일치해야 합니다
    const notionResponse = await notion.pages.create({
      parent: { database_id: NOTION_DB_ID },
      properties: {
        // ── Title (행사명) ──────────────────────────────────
        '행사': {
          title: [{ text: { content: event || '(미입력)' } }],
        },
        // ── 날짜 ───────────────────────────────────────────
        '날짜': {
          date: { start: date },
        },
        // ── 지출자 ─────────────────────────────────────────
        '지출자': {
          rich_text: [{ text: { content: submitter || '' } }],
        },
        // ── 부서 ───────────────────────────────────────────
        '부서': {
          select: { name: department || '기타' },
        },
        // ── 지출 유형 ──────────────────────────────────────
        '지출유형': {
          select: { name: category || '기타' },
        },
        // ── 총금액 ─────────────────────────────────────────
        '총금액': {
          number: totalAmount,
        },
        // ── 결제수단 ───────────────────────────────────────
        '결제수단': {
          select: { name: paymentMethod || '기타' },
        },
        // ── 품목내역 ───────────────────────────────────────
        '품목내역': {
          rich_text: [{ text: { content: itemsText } }],
        },
        // ── 비고 ───────────────────────────────────────────
        '비고': {
          rich_text: [{ text: { content: notes || '' } }],
        },
        // ── 상태 ───────────────────────────────────────────
        '상태': {
          select: { name: '검토 중' },
        },
      },
    });

    // ── 품목이 있으면 페이지 본문에도 상세 추가 ─────────────
    if (items.length > 0) {
      const tableRows = items.map(item => ({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{
            text: {
              content: `${item.name} | 단가: ₩${(item.unit_price || 0).toLocaleString()} | 수량: ${item.qty} | 소계: ₩${(item.price || 0).toLocaleString()}`
            }
          }]
        }
      }));

      await notion.blocks.children.append({
        block_id: notionResponse.id,
        children: [
          {
            object: 'block',
            type: 'heading_3',
            heading_3: { rich_text: [{ text: { content: '📋 영수증 품목 상세' } }] }
          },
          ...tableRows,
          {
            object: 'block',
            type: 'divider',
            divider: {}
          },
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{
                text: { content: `합계: ₩${totalAmount.toLocaleString()}` },
                annotations: { bold: true }
              }]
            }
          }
        ]
      });
    }

    return res.json({
      success: true,
      notionPageId: notionResponse.id,
      notionUrl: notionResponse.url,
      message: '노션 데이터베이스에 성공적으로 저장되었습니다.',
    });

  } catch (err) {
    console.error('[submit-expense]', err);
    return res.status(500).json({ error: '제출 중 오류가 발생했습니다.', detail: err.message });
  }
});

// ── 서버 시작 ──────────────────────────────────────────────
app.use(express.static(__dirname));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`\n🚀 서버 실행 중: http://localhost:${PORT}`);
  console.log(`   Claude API: ${process.env.ANTHROPIC_API_KEY ? '✓ 연결됨' : '✗ ANTHROPIC_API_KEY 없음'}`);
  console.log(`   Notion API: ${process.env.NOTION_API_KEY ? '✓ 연결됨' : '✗ NOTION_API_KEY 없음'}`);
  console.log(`   Notion DB:  ${process.env.NOTION_DATABASE_ID ? '✓ 설정됨' : '✗ NOTION_DATABASE_ID 없음'}\n`);
});
