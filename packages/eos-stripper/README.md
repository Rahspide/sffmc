# @sffmc/eos-stripper

Strips EOS (End-of-Sequence) tokens from assistant text output. Local models (Ollama, llama.cpp, vLLM) commonly emit these tokens in the middle of responses, confusing downstream tools and polluting the UI.

## Why

Per MiMo-Code PR #603: local models leak EOS tokens like `</s>`, `<|im_end|>`, `<|eot_id|>` into the text stream. These are model-internal control tokens that should never appear in user-visible output. Without stripping, they:
- Break markdown formatting
- Trigger false tool-call parsing
- Show raw tokens in the chat UI

## How

Hooks into `experimental.text.complete` and:
1. Checks if the entire text part is just EOS noise → replaces with empty string
2. Strips EOS patterns from the **end** of text only (middle occurrences are presumed intentional, e.g., in code examples)
3. Strips whitespace-padded EOS patterns (some models emit `  </s>`)

## Install

```bash
cp packages/eos-stripper/config/eos.example.yaml ~/.config/SFFMC/eos.yaml
```

Add to your opencode.json `plugin` array:
```json
"file:///data/projects/SFFMC/packages/eos-stripper/src/index.ts"
```

## Token cost

**0 tokens.** Pure text post-processing with no model calls.

## Compatible with

- Ollama
- llama.cpp
- vLLM
- Any open-source LLM that emits special tokens in text output
