# QW-InterviewAssitsant
一个基于qwen-max-latest(LLM) + paraformer-realtime-v2(实时语音模型)的一个实时语音AI面试助手<br>
An interview assistant based on qwen-max-latest(LLM)+ paraformer-Realtime-V2 (real-time voice model)

# (快速开始)Quick start
- 在`config.py`中配置API-KEY,获取网址：https://bailian.console.aliyun.com/?apiKey=1#/api-key
- 安装`requirements.txt`的相关库
``` 
pip install -r requirements.txt
```
  
- 要同时运行三个服务
```
uvicorn test-api-qwen:app --reload --port 2333
```
```
python .\server.py 
```
```
 python -m http.server 9000 
```
- 访问下面地址
```
http://localhost:9000/static/
```
示例图：
![](https://gitee.com/gracke/img/raw/master/SelfImg/202502190127160.png)
- 快捷键 `A-开始/暂停录音` `C-清除文本` `D-ai问答`
- 输入框 `Enter`键 输出文本 `Alt+Enter` 文本换行

# 可配置项（configurable options）
- 配置热词,可增加语音识别专有名词的准确性,本项目的`test`目录，也有写相关代码,可直接运行，但是要配置API-KEY参考网址：https://help.aliyun.com/zh/model-studio/developer-reference/custom-hot-words
- 在`cache`目录,可以编辑`prompt.txt`写提示词
- 可编辑快捷键在`scripts.js`文件可修改
- 可将聊天记录保存为md文件

# 参考项目（Reference item）
[在网页中录音并进行语音识别](https://github.com/aliyun/alibabacloud-bailian-speech-demo/tree/master/samples/gallery/input-text-out-audio-html-ai-assistant)
