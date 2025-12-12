import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

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

export async function GET() {
  return NextResponse.json({ ok: true, message: "Use POST /api/food/guess" });
}

export async function POST(req: Request) {
  try {
    const body = ReqSchema.parse(await req.json());

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

    const base64 = body.imageBase64.replace(/^data:image\/\w+;base64,/, "");

    const prompt = [
      "Return ONLY JSON in this shape: {\"items\":[{\"name\":string,\"grams\":number,\"nutrients\":{\"calories\":number,\"protein_g\":number,\"carbs_g\":number,\"fat_g\":number}}]}",
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

    const textOut =
      data.output_text ??
      data.output?.find((o: any) => o.type === "message")?.content?.[0]?.text ??
      "";

    const json = JSON.parse(textOut);
    const parsed = ResSchema.safeParse(json);

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
