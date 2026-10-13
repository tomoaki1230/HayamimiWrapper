"""テスト用の偽 subtitle_server（本物と同じく EventHub.publish を持つ）"""


class EventHub:
    def publish(self, event):
        pass
