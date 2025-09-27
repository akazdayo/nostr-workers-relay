from wordcloud import WordCloud
import MeCab
import matplotlib.pyplot as plt
import requests
import os

# 形態素解析モデルの構築
t = MeCab.Tagger()


def analyze_strings(strings):
    """
    文字列配列に対して形態素解析を行い、名詞・動詞・形容詞のみを抽出する
    """
    result_words = []

    for text in strings:
        # 形態素解析実行
        parsed = t.parse(text)

        # 解析結果を行ごとに分割
        lines = parsed.split("\n")

        for line in lines:
            if line == "EOS" or line == "":
                continue

            # 形態素情報を分割
            parts = line.split("\t")
            if len(parts) < 5:
                continue

            word = parts[0]

            # unidic-liteでは品詞情報が5番目のカラムにある
            pos_info = parts[4]  # 品詞情報
            pos = pos_info.split("-")[0] if "-" in pos_info else pos_info

            # 名詞・動詞・形容詞のみを抽出（非自立は除外）
            if pos in ["名詞", "動詞", "形容詞"]:
                # if "非自立" not in pos_info:
                result_words.append(word)

    return result_words


def generate_wordcloud(strings, output_path="wordcloud.png"):
    """
    文字列配列からワードクラウドを生成する
    """
    # 形態素解析で単語を抽出
    words = analyze_strings(strings)

    # 単語をスペース区切りのテキストに変換
    text = " ".join(words)

    if not text.strip():
        print("抽出された単語がありません")
        return

    # ワードクラウドを生成
    wordcloud = WordCloud(
        width=1920,
        height=1080,
        background_color="white",
        max_words=100,
        font_path="./fonts/NotoSansJP-Regular.ttf",
        colormap="viridis",
    ).generate(text)

    # 画像として保存
    plt.figure(figsize=(10, 5))
    plt.imshow(wordcloud, interpolation="bilinear")
    plt.axis("off")
    plt.tight_layout(pad=0)
    plt.savefig(output_path, dpi=300, bbox_inches="tight")
    plt.show()

    print(f"ワードクラウドを {output_path} に保存しました")


def fetch_texts(url):
    response = requests.get(url)
    if response.status_code == 200:
        return response.json()
    else:
        print(f"Failed to fetch data from {url}")
        return []


if __name__ == "__main__":
    # 例として、URLからテキストデータを取得してワードクラウドを生成
    url = "https://nostr-worker-relay.akazdayo.workers.dev/get-event"  # ここに実際のURLを指定
    texts = fetch_texts(url)
    generate_wordcloud(texts, output_path="wordcloud.png")
