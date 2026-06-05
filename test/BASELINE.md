# Baseline results — Claude Sonnet 4.6 pipeline (tiling + ensemble + box_code grouping)

Recorded before evaluating Amazon Textract as an alternative/supplement.

## Counting accuracy (12 images, live API, all parallel)

Run wall-clock: ~139s for all 12 in parallel. **10/12 exact, total abs error 2.**

| Image | True | Got | VC breakdown (by carton box_code) | Note |
|-------|------|-----|-----------------------------------|------|
| IMG_5816.jpeg | 31 | 31 | VC9=22, VC11.2=9 | exact |
| IMG_5817.jpeg | 34 | 34 | VC9=31, VC11.2=1, VC7.5=1, VC4.2=1 | exact |
| IMG_5818.jpeg | 4  | 4  | VC19=4 | exact (close-up, single tile) |
| IMG_5819.jpeg | 15 | 15 | VC35=13, VC30=2 | exact (single tile) |
| IMG_5825.jpeg | 22 | 22 | VC9=22 | exact |
| z7684272505382… | 45 | 46 | VC9=38, VC7.5=7, VC11.2=1 | +1 jitter |
| z7684272512641… | 27 | 27 | VC9=19, VC11.2=8 | exact |
| z7684272609303… | 42 | 42 | VC9=32, VC7.5=5, VC11.2=4, VC4.2=1 | exact (1 pink box) |
| z7684272634118… | 45 | 44 | VC7.5=30, VC9=14 | -1 jitter |
| z7706421817056… | 36 | 36 | VC11.2=19, VC9=17 | exact |
| z7706421874606… | 30 | 30 | VC11.2=30 | exact |
| z7706425611275… | 40 | 40 | VC9=28, VC11.2=12 | exact |

## Known field-extraction issues (to address)

1. **shop_name vs destination**: a value is a `destination` ONLY if it contains a comma
   (full address). Otherwise it's a `shop_name`. Examples that must be shop_name:
   `.HA NOI DC`, `.HN TRUNG HOA`, `.HN-THANH CONG`, `HN - XA DAN`, `HN-RETAIL`.
2. **order_number** prefix should read as `TO-...` (model sometimes reads `TD-...`).
3. **Missing fields**: on dense images, the model sometimes drops fields per label
   (label printed with a lot of fine text). Candidate fix: Amazon Textract OCR.

## Pipeline at time of baseline
- Model: global.anthropic.claude-sonnet-4-6 (Bedrock, ap-southeast-1)
- Tiling by hole-cluster column boundaries; ENSEMBLE VOTES=3 parallel; THINKING_BUDGET=16000;
  re-examine under-counted columns; hole-detector cross-check; box_code grouping by base VC.
