import time

import RPi.GPIO as GPIO

BUZZER_PIN = 23  # BCM GPIO23 is physical header pin 16.
BUZZER_FREQ_HZ = 1500


class Buzzer:
    def __init__(self, pin):
        self.pin = pin
        GPIO.setup(self.pin, GPIO.OUT, initial=GPIO.LOW)
        self.pwm = GPIO.PWM(self.pin, BUZZER_FREQ_HZ)
        self.pwm.start(0)

    def on(self):
        self.pwm.ChangeDutyCycle(50)

    def off(self):
        self.pwm.ChangeDutyCycle(0)

    def close(self):
        self.pwm.stop()


def main():
    GPIO.setmode(GPIO.BCM)
    buzzer = Buzzer(BUZZER_PIN)
    try:
        input("Press Enter to play a 1.5 kHz tone for 3 seconds...")
        buzzer.on()
        time.sleep(3)
        buzzer.off()
        print("Buzzer turned off.")
    except KeyboardInterrupt:
        pass
    finally:
        buzzer.off()
        buzzer.close()
        GPIO.cleanup(buzzer.pin)


if __name__ == "__main__":
    main()
