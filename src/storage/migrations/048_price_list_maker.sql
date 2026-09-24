-- The service that bills a model is not the company that made it.
--
-- Every row the Google Cloud price list produced was stored with `maker: "Google Cloud"`, including
-- GLM 5 and 5.2, Qwen 3, 3.5 and 3.6, Llama 3.1 through 4, and GPT-OSS 20B and 120B -- fourteen
-- models by Zhipu, Alibaba, Meta and OpenAI, each of which would have been announced under Google's
-- name and pinged Google's role. The collector reads the maker from the model's own name now.
--
-- The rewrite happens here rather than on the next collection because a corrected field is still a
-- changed field: eighty-seven rows changing at once would have been read as the source doing
-- something, and five or six of them would have reached a channel as a card about a word we got
-- wrong ourselves. A migration changes the stored rows with nobody told, which is what a correction
-- of our own reading deserves.

UPDATE records SET body = json_set(
  json_set(body, '$.maker',
    CASE
      WHEN id LIKE 'glm%' THEN 'Z.ai'
      WHEN id LIKE 'qwen%' THEN 'Qwen'
      WHEN id LIKE 'llama%' THEN 'Meta'
      WHEN id LIKE 'gpt-oss%' THEN 'OpenAI'
      ELSE 'Google'
    END),
  '$.service', 'Google Cloud')
WHERE source = 'google-skus';
