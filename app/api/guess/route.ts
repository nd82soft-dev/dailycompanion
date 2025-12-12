import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs"; // easier for SDKs + larger payloads

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return NextResponse.json({
    ok: true,
    receivedKeys: Object.keys(body ?? {}),
    items: [],
  });
}

// Optional: makes browser testing easy (GET will be 200 instead of 405)
export async function GET() {
  return NextResponse.json({ ok: true, message: "Use POST /api/food/guess" });
}

const ReqSchema = z.object({
  imageBase64: z.string().min(100),
  mealHint: z.string().optional(),
});

const ResSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        grams: z.number().min(1).max(2000),
        nutrients: z.object({
          calories: z.number().min(0).max(5000),
          protein_g: z.number().min(0).max(500),
          carbs_g: z.number().min(0).max(500),
          fat_g: z.number().min(0).max(500),
        }),
      })
    )
    .max(8),
});

export async function POST(req: Request) {
  try {
    const body = ReqSchema.parse(await req.json());

    // Optional: reject huge payloads early (base64 is large)
    if (body.imageBase64.length > 3_500_000) {
      return NextResponse.json(
        { error: "Image too large. Retake with lower quality." },
        { status: 413 }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
    }

    // Expect base64 without data URL prefix; if you send data URL, strip it.
    const base64 = body.imageBase64.replace(/^data:image\/\w+;base64,/, "");

    // Uses OpenAI Responses API via fetch (no dependency required).
    const prompt = [
      "You are a nutrition assistant.",
      "From this photo, identify the most likely foods the user will log.",
      "Return 1-4 items max. Use realistic portion grams.",
      "Provide approximate calories/protein/carbs/fat for that portion.",
      "If unsure, choose the simplest common interpretation and be conservative.",
      body.mealHint ? `Meal hint: ${body.mealHint}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: `data:image/jpeg;base64,${base64}` },
            ],
          },
        ],
        text: { format: { type: "json_object" } },
      }),
    });

    if (!openaiRes.ok) {
      const t = await openaiRes.text().catch(() => "");
      return NextResponse.json({ error: `AI error: ${openaiRes.status} ${t}` }, { status: 502 });
    }

    const data = await openaiRes.json();

    // The model returns JSON as text; pull it out:
    const textOut =
      data.output_text ??
      data.output?.find((o: any) => o.type === "message")?.content?.[0]?.text ??
      "";

    const parsed = ResSchema.safeParse(JSON.parse(textOut));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "AI returned unexpected format", details: parsed.error.flatten() },
        { status: 502 }
      );
    }

    return NextResponse.json(parsed.data);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Bad request" }, { status: 400 });
  }

}
