---
name: weekly-meal-plan
description: >-
  Plan simple, balanced weekly menus (breakfast, lunch, dinner, snack) with portions, cooking order,
  leftovers and a shopping list, built around what is already in the grocery basket, then fill the
  basket. Use it whenever the user asks for menus or meal ideas for several days, or says in French
  « menus de la semaine », « menu équilibré », « qu'est-ce que je mange cette semaine »,
  « idées de repas », « planning repas », « batch cooking », « repas pour la semaine », even when they
  only mention a diet goal or the dishes already in their basket.
---

# Weekly meal plan

Goal: a week of meals that is balanced, simple to cook, cheap enough, and that uses what the user
already bought. Answer in the user's language (French for French requests).

## 1. Who is eating

Look for the user's profile in memory: household size, sex, age, height, weight, activity level,
goal, eating pattern (some people never eat breakfast), allergies, dislikes, budget. Ask only for what would change the plan (how many people, a goal
such as losing weight, allergies). For anything else, state the assumption in one line and move on.
Keep this data in private memory: never write it into a repository, a commit or a published file.

Estimate energy needs with Mifflin-St Jeor: men `10 × kg + 6.25 × cm − 5 × age + 5`, women
`… − 161`. Multiply by the activity factor: 1.2 sedentary, 1.375 light, 1.55 moderate, 1.725 active.
Aiming 300–500 kcal below that gives slow weight loss without hunger. Spread the target over the meals
the person actually eats: without breakfast, lunch and dinner each carry about 40 % and an afternoon
snack the rest. Say what you aimed for and why
in one sentence; no lectures about weight.

## 2. Start from the basket

Call `get_cart` (intermarche-drive) when the MCP is available. Dishes already bought are fixed points:
place them first and scale them to the household. A recipe bought for 4 but eaten by 1 person becomes
two meals, not four; the rest goes back to the pantry. Avoid the same heavy dish twice in a row.

## 3. Build the week

**Plate rules** (one line in the output):
- half the plate vegetables;
- a palm-sized protein (120–150 g meat or fish, 2–3 eggs, a can of fish, a portion of legumes);
- measured starch: 80–100 g dry pasta or rice, 250 g potatoes, or 2 slices of bread;
- about 1 tablespoon of oil per meal.

**Over the week:**
- fish twice (one oily, such as salmon or sardines);
- legumes twice;
- red meat 2–3 times at most, and as little charcuterie as possible;
- 2 fruits a day, dairy every day, wholegrain starch when it is easy.

**Keep it simple:**
- few distinct ingredients, each used at least twice;
- cook once, eat twice (rice and chicken for two lunches);
- 2–3 breakfasts on rotation;
- weekday dinners in 20–30 minutes;
- one easy "plaisir" meal (croque-monsieur, pizza night) keeps the plan realistic.

**Order the days by shelf life:**
- fresh minced meat and fresh fish on days 1–2;
- opened charcuterie within 2–3 days;
- cooked leftovers within 3 days, otherwise freeze;
- frozen fish and vegetables for the end of the week.

Dishes that do not reheat well, such as carbonara or omelettes, are cooked per portion. Plan to use
leftover egg whites, half cans and so on.

## 4. Output

Use this structure. The headings are shown in French; translate them for another language.

1. **Hypothèses**, in one or two lines: target kcal, household, anything assumed.
2. **Repères simples**: the plate rules, in short bullets.
3. **Petit-déjeuner et collation**: the rotation. Only the snack when the person skips breakfast.
4. **La semaine**: a table `Jour | Midi | Soir`. Mark dishes already in the basket with 🛒 and give
   their portion (for example « portion 1/2 »).
5. **Ordre et conservation**: one short paragraph on why the days are in this order.
6. **Ce qu'il manque au panier**: grouped as Frais / Fruits et légumes / Épicerie / Surgelés, with
   rough quantities. List the pantry staples you assumed (oil, vinegar, salt, pepper, herbs,
   coffee or tea) so the user can object.
7. **Restes pour la semaine suivante**, when there are any.
8. An offer to fill the basket.

## 5. Hand-off to the basket

When the user agrees, follow the `intermarche-shopping` skill:
- cheapest suitable products checked against `packaging`;
- shelf-life-aware choices (frozen for late in the week);
- one `add_items` call;
- report the total.

Offer a quality check (Nutri-Score, processing, additives) when the user cares about it.
