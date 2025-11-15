from flask import Flask, request, jsonify
import os

app = Flask(__name__)

@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'ok': True, 'version': 'ollama-stub-1.0'})

@app.route('/api/tags', methods=['GET'])
def tags():
    # Return a small list of models
    models = [
        {'name': 'nomic-embed-text', 'size': 100000, 'modified_at': '2025-11-01T00:00:00Z'},
    ]
    return jsonify({'models': models})

@app.route('/api/pull', methods=['POST'])
def pull():
    body = request.get_json(force=True, silent=True) or {}
    name = body.get('name')
    if not name:
        return jsonify({'error': 'model required'}), 400
    # Simulate a short delay
    return jsonify({'status': 'pulled', 'name': name}), 200

@app.route('/api/delete', methods=['DELETE', 'POST'])
def delete():
    body = request.get_json(force=True, silent=True) or {}
    name = body.get('name') or body.get('model')
    if not name:
        return jsonify({'error': 'model required'}), 400
    return jsonify({'status': 'deleted', 'name': name}), 200

@app.route('/')
def root():
    return jsonify({'status':'hello stub', 'version':'ollama-stub-1.0'})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 11434))
    app.run(host='0.0.0.0', port=port)
